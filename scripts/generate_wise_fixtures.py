"""Generate synthetic statements only; never read or transform a customer's file."""
from io import BytesIO, StringIO
from pathlib import Path
import csv
from xml.sax.saxutils import escape
from zipfile import ZipFile, ZIP_DEFLATED
from pypdf import PdfWriter
from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject

IBAN='BE71096123456769'
ROWS=(('CARD-100','03-10-2026','-5.00','Synthetic shop'),
      ('CARD-100','03-10-2026','-5.00','Synthetic shop'),
      ('TRANSFER-200','15-10-2026','12.50','Synthetic refund'))
HEADER=('TransferWise ID','Date','Amount','Currency','Description')


def pdf(lines=None,blank=False):
    writer=PdfWriter(); page=writer.add_blank_page(width=595,height=842)
    if not blank:
        font=DictionaryObject({NameObject('/Type'):NameObject('/Font'),NameObject('/Subtype'):NameObject('/Type1'),NameObject('/BaseFont'):NameObject('/Helvetica')})
        page[NameObject('/Resources')]=DictionaryObject({NameObject('/Font'):DictionaryObject({NameObject('/F1'):writer._add_object(font)})})
        stream=DecodedStreamObject()
        def literal(line):return line.replace('\\','\\\\').replace('(','\\(').replace(')','\\)')
        commands=['BT /F1 10 Tf 30 790 Td']
        for index,line in enumerate(lines or ['Unknown synthetic statement']):
            commands.append(('0 -16 Td ' if index else '')+'('+literal(line)+') Tj')
        stream.set_data((' '.join(commands)+' ET').encode('ascii'));page[NameObject('/Contents')]=writer._add_object(stream)
    result=BytesIO();writer.write(result);return result.getvalue()


def bundle(iban=IBAN, rows=ROWS):
    stream=StringIO(); writer=csv.writer(stream);writer.writerow(HEADER)
    for ref,dt,amount,desc in rows:writer.writerow((ref,dt,amount,'EUR',desc))
    csv_bytes=stream.getvalue().encode()
    # XLSX mirrors the established Wise CSV columns, using OOXML inline strings.
    cells=[]
    for index,record in enumerate([HEADER]+[(r,d,a,'EUR',p) for r,d,a,p in rows],1):
        cells.append('<row r="'+str(index)+'">'+''.join(f'<c r="{chr(65+i)}{index}" t="inlineStr"><is><t>{escape(value)}</t></is></c>' for i,value in enumerate(record))+'</row>')
    out=BytesIO()
    with ZipFile(out,'w',ZIP_DEFLATED) as z:
        z.writestr('[Content_Types].xml','<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>')
        z.writestr('_rels/.rels','<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>')
        z.writestr('xl/workbook.xml','<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Statement" sheetId="1" r:id="rId1"/></sheets></workbook>')
        z.writestr('xl/_rels/workbook.xml.rels','<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>')
        z.writestr('xl/worksheets/sheet1.xml','<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>'+''.join(cells)+'</sheetData></worksheet>')
    pdf_lines=['Wise Payments Limited','EUR statement','1 October 2026 [GMT+03:00] - 31 October 2026 [GMT+02:00]',
        'Account holder','Synthetic Member','IBAN',iban,'Description Incoming Outgoing Amount']
    entries=[]; mt=[':20:SYNTHETIC',':25:'+iban,':28C:1/1',':60F:C261001EUR100,00']; qif=['!Type:Bank']
    for i,(ref,dt,amount,desc) in enumerate(rows):
        d,m,y=dt.split('-'); iso=f'{y}-{m}-{d}'; long=f'{int(d)} October {y}'
        pdf_lines += [desc+' '+amount+' 100.00',long+' | Transaction: '+ref]
        sign='DBIT' if amount.startswith('-') else 'CRDT'; absolute=amount.lstrip('-')
        entries.append(f'<Ntry><Amt Ccy="EUR">{absolute}</Amt><CdtDbtInd>{sign}</CdtDbtInd><Sts><Cd>BOOK</Cd></Sts><BookgDt><Dt>{iso}</Dt></BookgDt><NtryDtls><TxDtls><Refs><TxId>{ref}</TxId></Refs><RmtInf><Ustrd>{escape(desc)}</Ustrd></RmtInf></TxDtls></NtryDtls></Ntry>')
        mt += [f':61:{y[2:]}{m}{d}{m}{d}{"D" if sign=="DBIT" else "C"}{absolute.replace(".",",")}NTRFNONREF//{ref}',':86:'+desc]
        qif += [f'D{d}/{m}/{y}','T'+amount,'P'+desc,'^']
    mt.append(':62F:C261031EUR102,50')
    camt=f'<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.10"><BkToCstmrStmt><Stmt><Id>SYNTHETIC</Id><FrToDt><FrDtTm>2026-10-01T00:00:00Z</FrDtTm><ToDtTm>2026-10-31T23:59:59Z</ToDtTm></FrToDt><Acct><Id><IBAN>{iban}</IBAN></Id><Ccy>EUR</Ccy></Acct>{"".join(entries)}</Stmt></BkToCstmrStmt></Document>'
    return {'csv':csv_bytes,'xlsx':out.getvalue(),'pdf':pdf(pdf_lines),'xml':camt.encode(),'mt940':('\n'.join(mt)+'\n').encode(),'qif':('\n'.join(qif)+'\n').encode()}


def write_bundle(directory):
    directory=Path(directory);directory.mkdir(parents=True,exist_ok=True)
    for format,content in bundle().items():(directory/('synthetic.'+format)).write_bytes(content)
    (directory/'scanned.pdf').write_bytes(pdf(blank=True))
    (directory/'unknown.pdf').write_bytes(pdf())
    (directory/'broken.pdf').write_bytes(b'%PDF-broken')
    second=bundle('BE00000000000000',tuple((r,d,a,p.replace('Synthetic','Second account')) for r,d,a,p in ROWS))
    (directory/'second.xml').write_bytes(second['xml'])
