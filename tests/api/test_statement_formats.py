from io import BytesIO
from zipfile import ZipFile
from datetime import date
from xml.etree import ElementTree as ET
import pytest
from scripts.generate_wise_fixtures import bundle, pdf, ROWS
from app.statement_formats import parse_statement
from app.statement_wise import WiseStatementError
from app.statement_files import fingerprint


@pytest.mark.parametrize('format',['csv','pdf','xlsx','xml','mt940','qif'])
def test_all_variants_preserve_dates_amounts_and_separate_purchases(format):
    data=parse_statement(bundle()[format],format,'day_first')
    assert len(data.rows)==3
    assert [(r.booked_on.isoformat(),r.amount_minor,r.description) for r in data.rows]==[
        ('2026-10-03',-500,'Synthetic shop'),('2026-10-03',-500,'Synthetic shop'),('2026-10-15',1250,'Synthetic refund')]
    assert 'Synthetic shop' not in repr(data)


def test_csv_pdf_xlsx_camt_mt940_whole_statement_fingerprints_agree():
    signatures=[]
    for format in ('csv','pdf','xlsx','xml','mt940'):
        parsed=parse_statement(bundle()[format],format)
        signatures.append(fingerprint([dict(ref=r.reference,date=r.booked_on.isoformat(),amount=r.amount_minor,description=r.description) for r in parsed.rows]))
    assert len(set(signatures))==1
    # The occurrence count remains part of the statement identity.
    changed=bundle(rows=ROWS[1:])
    parsed=parse_statement(changed['csv'],'csv')
    assert signatures[0]!=fingerprint([dict(ref=r.reference,date=r.booked_on.isoformat(),amount=r.amount_minor,description=r.description) for r in parsed.rows])


@pytest.mark.parametrize('content,code',[(pdf(blank=True),'no_text_use_csv'),(pdf(),'unsupported_pdf_layout'),(b'%PDF-broken','unreadable_pdf')])
def test_pdf_errors_are_specific_and_private(content,code):
    with pytest.raises(WiseStatementError,match=code):parse_statement(content,'pdf')


def test_qif_requires_explicit_date_order_and_currency_remains_unknown():
    with pytest.raises(WiseStatementError,match='qif_date_order_required'):parse_statement(bundle()['qif'],'qif')
    assert parse_statement(bundle()['qif'],'qif','day_first').currency is None


def test_xml_rejects_entities_versions_aggregates_and_other_currencies():
    source=bundle()['xml']
    for bad in (b'<!DOCTYPE x [<!ENTITY x "private">]>'+source,source.replace(b'.001.10',b'.001.08'),
                source.replace(b'EUR',b'USD'),source.replace(b'</TxDtls>',b'</TxDtls><TxDtls/>')):
        with pytest.raises(WiseStatementError):parse_statement(bad,'xml')


def test_malformed_workbook_and_partial_qif_fail_closed():
    with pytest.raises(WiseStatementError):parse_statement(b'not a zip','xlsx')
    with pytest.raises(WiseStatementError):parse_statement(bundle()['qif'][:-3],'qif','day_first')


def test_xlsx_numeric_dates_and_shared_strings_preserve_the_same_records():
    ns='http://schemas.openxmlformats.org/spreadsheetml/2006/main'
    output=BytesIO(); shared=[]
    with ZipFile(BytesIO(bundle()['xlsx'])) as original, ZipFile(output,'w') as modified:
        for name in original.namelist():
            content=original.read(name)
            if name=='xl/worksheets/sheet1.xml':
                root=ET.fromstring(content)
                for cell in root.iter('{'+ns+'}c'):
                    value=''.join(cell.itertext()); address=cell.get('r')
                    for child in list(cell):cell.remove(child)
                    if address.startswith('B') and address!='B1':
                        d,m,y=map(int,value.split('-'));cell.attrib.pop('t')
                        value=str((date(y,m,d)-date(1899,12,30)).days)
                    else:
                        shared.append(value);cell.set('t','s');value=str(len(shared)-1)
                    ET.SubElement(cell,'{'+ns+'}v').text=value
                content=ET.tostring(root)
            modified.writestr(name,content)
        root=ET.Element('{'+ns+'}sst')
        for value in shared:ET.SubElement(ET.SubElement(root,'{'+ns+'}si'),'{'+ns+'}t').text=value
        modified.writestr('xl/sharedStrings.xml',ET.tostring(root))
    result=parse_statement(output.getvalue(),'xlsx')
    assert [r.booked_on.isoformat() for r in result.rows]==['2026-10-03','2026-10-03','2026-10-15']
    assert [r.amount_minor for r in result.rows]==[-500,-500,1250]


def test_pdf_wrapped_description_amount_line_and_page_header():
    lines=['Wise','EUR statement','1 October 2026 [GMT+03:00] - 31 October 2026 [GMT+02:00]',
        'IBAN','BE71096123456769','Description Incoming Outgoing Amount','Synthetic wrapped',
        'shop','-5.00 95.00','3 October 2026 | Card ending in 1111 | Transaction: CARD-1']
    parsed=parse_statement(pdf(lines),'pdf')
    assert parsed.rows[0].description=='Synthetic wrapped shop'
