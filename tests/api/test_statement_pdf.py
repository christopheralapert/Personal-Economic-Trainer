from io import BytesIO
import pytest
from pypdf import PdfWriter
from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject
from app.statement_pdf import extract_statement_text, StatementPdfError, MAX_PDF_BYTES


def synthetic_pdf(with_text=True):
    writer=PdfWriter()
    page=writer.add_blank_page(width=200,height=200)
    if with_text:
        font=DictionaryObject({NameObject('/Type'):NameObject('/Font'),NameObject('/Subtype'):NameObject('/Type1'),NameObject('/BaseFont'):NameObject('/Helvetica')})
        page[NameObject('/Resources')]=DictionaryObject({NameObject('/Font'):DictionaryObject({NameObject('/F1'):writer._add_object(font)})})
        stream=DecodedStreamObject(); stream.set_data(b'BT /F1 12 Tf 10 150 Td (Synthetic statement) Tj ET')
        page[NameObject('/Contents')]=writer._add_object(stream)
    result=BytesIO();writer.write(result);return result.getvalue()


def test_extracts_synthetic_text_without_persisting():
    assert 'Synthetic statement' in extract_statement_text(synthetic_pdf())[0]


def test_scanned_or_blank_page_recommends_csv():
    with pytest.raises(StatementPdfError,match='no_text_use_csv'):
        extract_statement_text(synthetic_pdf(False))

@pytest.mark.parametrize('content,code', [(b'nope','unsupported_pdf'),(b'%PDF-broken','unreadable_pdf'),(b'x'*(MAX_PDF_BYTES+1),'invalid_size')])
def test_bad_pdf_reports_only_safe_code(content,code):
    with pytest.raises(StatementPdfError,match=code):extract_statement_text(content)


def test_rejects_a_missing_text_layer_on_any_page():
    from pypdf import PdfReader
    writer=PdfWriter()
    writer.add_page(PdfReader(BytesIO(synthetic_pdf())).pages[0])
    writer.add_blank_page(width=200,height=200)
    result=BytesIO();writer.write(result)
    with pytest.raises(StatementPdfError,match='no_text_use_csv'):
        extract_statement_text(result.getvalue())
