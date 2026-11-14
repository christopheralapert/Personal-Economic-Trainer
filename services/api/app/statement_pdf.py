"""Offline PDF text extraction for statement-adapter development.

Not an upload API or a transaction parser. Never logs extracted content.
"""
from io import BytesIO
from pypdf import PdfReader

MAX_PDF_BYTES = 5 * 1024 * 1024
MAX_PDF_PAGES = 30
MAX_TEXT_CHARS = 1_000_000

class StatementPdfError(ValueError):
    """Fixed safe reason code; input or parser errors must not be included."""


def extract_statement_text(content: bytes) -> tuple[str, ...]:
    if not isinstance(content, bytes) or not content or len(content) > MAX_PDF_BYTES:
        raise StatementPdfError('invalid_size')
    if not content.startswith(b'%PDF-'):
        raise StatementPdfError('unsupported_pdf')
    try:
        reader = PdfReader(BytesIO(content), strict=True)
        if reader.is_encrypted:
            raise StatementPdfError('encrypted_pdf')
        if not 1 <= len(reader.pages) <= MAX_PDF_PAGES:
            raise StatementPdfError('unsupported_page_count')
        pages = []
        length = 0
        for page in reader.pages:
            text = page.extract_text() or ''
            if not text.strip():
                raise StatementPdfError('no_text_use_csv')
            length += len(text)
            if length > MAX_TEXT_CHARS:
                raise StatementPdfError('text_too_large')
            pages.append(text)
        return tuple(pages)
    except StatementPdfError:
        raise
    except Exception:
        raise StatementPdfError('unreadable_pdf') from None
