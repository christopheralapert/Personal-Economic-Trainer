from datetime import date
import pytest
from app.statement_lhv import parse_lhv_candidate_row, StatementRowError


def row():
    return ['EE000000000000000000', '1', '31.10.2026', '', 'Synthetic merchant', 'D', '-12,34', '', '', '', 'EUR', '', '', '', '', 'source-1']


def test_documented_lhv_positions_and_exact_decimal():
    result = parse_lhv_candidate_row(row(), decimal_separator=',')
    assert (result.booked_on, result.amount_minor, result.currency, result.reference) == (date(2026, 10, 31), -1234, 'EUR', 'source-1')
    assert 'Synthetic merchant' not in repr(result)


@pytest.mark.parametrize('index,value,code', [(5,'C','direction_amount_conflict'),(6,'12,345','invalid_amount'),(10,'USD','unsupported_currency'),(15,'','missing_identity_or_currency'),(2,'31.02.2026','invalid_date')])
def test_reject_ambiguous_rows_without_disclosing_values(index,value,code):
    fields=row(); fields[index]=value
    with pytest.raises(StatementRowError, match=code) as error:
        parse_lhv_candidate_row(fields,decimal_separator=',')
    assert 'Synthetic merchant' not in str(error.value)


def test_preserves_distinct_bank_references_for_identical_purchases():
    one=row(); two=row(); two[15]='source-2'
    first=parse_lhv_candidate_row(one,decimal_separator=','); second=parse_lhv_candidate_row(two,decimal_separator=',')
    assert first.amount_minor == second.amount_minor and first.reference != second.reference
