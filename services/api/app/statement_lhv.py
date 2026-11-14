"""Candidate LHV CSV row validator; never publishes or logs source data.

Field order follows the public LHV statement documentation dated 30.03.2026.
Header spellings and real export edge cases still require an actual redacted
sample, so this module is deliberately not connected to the upload API.
"""
from dataclasses import dataclass
from datetime import date, datetime
from decimal import Decimal, InvalidOperation
import re


class StatementRowError(ValueError):
    """A safe reason code: never include raw cell values in error messages."""


@dataclass(frozen=True, repr=False)
class LhvCandidateRow:
    account: str
    reference: str
    booked_on: date
    amount_minor: int
    currency: str
    counterparty: str


def parse_lhv_candidate_row(fields: list[str], *, decimal_separator: str) -> LhvCandidateRow:
    if len(fields) != 16 or decimal_separator not in ('.', ','):
        raise StatementRowError('unsupported_layout')
    account, direction, raw_amount, currency, reference = (fields[i].strip() for i in (0, 5, 6, 10, 15))
    if not account or not reference or not currency:
        raise StatementRowError('missing_identity_or_currency')
    if currency != 'EUR':
        raise StatementRowError('unsupported_currency')
    if direction not in ('D', 'C'):
        raise StatementRowError('invalid_direction')
    pattern = r'-?\d+(?:' + re.escape(decimal_separator) + r'\d{1,2})?'
    if not re.fullmatch(pattern, raw_amount):
        raise StatementRowError('invalid_amount')
    try:
        amount = Decimal(raw_amount.replace(decimal_separator, '.'))
        cents = amount * 100
        if not cents.is_finite() or abs(cents) > 9007199254740991:
            raise StatementRowError('invalid_amount')
        minor = int(cents)
    except InvalidOperation:
        raise StatementRowError('invalid_amount') from None
    if minor == 0 or (direction == 'D' and minor > 0) or (direction == 'C' and minor < 0):
        raise StatementRowError('direction_amount_conflict')
    booked = None
    for fmt in ('%Y-%m-%d', '%d.%m.%Y'):
        try:
            booked = datetime.strptime(fields[2].strip(), fmt).date()
            break
        except ValueError:
            pass
    if booked is None:
        raise StatementRowError('invalid_date')
    return LhvCandidateRow(account=account, reference=reference, booked_on=booked,
                           amount_minor=minor, currency=currency, counterparty=fields[4].strip())
