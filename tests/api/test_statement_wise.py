import pytest
from app.statement_wise import preview_wise_csv, WiseStatementError

HEADER = 'TransferWise ID,Date,Amount,Currency,Description\n'

def test_duplicate_reference_stays_visible_for_review():
    preview=preview_wise_csv((HEADER+'private-ref-184,03-10-2026,-5.00,EUR,First\nprivate-ref-184,03-10-2026,-5.00,EUR,Second\n').encode())
    assert len(preview.rows)==2 and preview.conflicting_references==1
    assert [row.amount_minor for row in preview.rows]==[-500,-500]
    assert 'First' not in repr(preview) and 'private-ref-184' not in repr(preview)

@pytest.mark.parametrize('row,code',[
 ('a,03-10-2026,-5.001,EUR,private\n','invalid_amount'),
 ('a,31-02-2026,-5.00,EUR,private\n','invalid_date'),
 ('a,03-10-2026,-5.00,USD,private\n','unsupported_currency'),
 (',03-10-2026,-5.00,EUR,private\n','invalid_reference_or_date'),
])
def test_invalid_row_fails_closed_without_disclosing_source(row,code):
    with pytest.raises(WiseStatementError,match=code) as exc:
        preview_wise_csv((HEADER+row).encode())
    assert 'private' not in str(exc.value)

def test_unknown_and_duplicate_headers_are_rejected():
    for content in (b'Other,Date\na,01-01-2026\n',b'TransferWise ID,TransferWise ID,Date,Amount,Currency,Description\n'):
        with pytest.raises(WiseStatementError,match='unsupported_layout'):
            preview_wise_csv(content)


def test_rejects_unrenderable_or_truncated_descriptions():
    for description in ('x'*201, 'bad\x00value'):
        with pytest.raises(WiseStatementError,match='invalid_description'):
            preview_wise_csv((HEADER+'a,03-10-2026,-5.00,EUR,'+description+'\n').encode())
