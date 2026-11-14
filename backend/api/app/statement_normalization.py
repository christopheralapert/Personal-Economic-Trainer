"""Bounded statement adapters and the encrypted, normalized-once staging contract.

Wise and the explicit canonical CSV schema are exposed by the upload API.
LHV accepts already separated
candidate CSV fields for offline adapter verification; it is not a file parser.
References stay inside encrypted previews; hashes and ordinals link saved rows.
"""
from collections import Counter
import csv
from datetime import date, timedelta
import hashlib
from io import StringIO
import json
import re
from typing import Literal

from pydantic import Field, ValidationError, field_validator

from .contracts import Contract, Minor
from .statement_lhv import parse_lhv_candidate_row
from .statement_wise import preview_wise_csv

MAX_UPLOAD_BYTES = 65536
MAX_IMPORT_ROWS = 1000
PUBLIC_FORMATS = ('wise_csv', 'canonical_csv')
CANONICAL_HEADER = ('reference', 'booked_on', 'amount_minor', 'currency', 'description')


class StatementNormalizationError(ValueError):
    """A fixed reason code, never input values."""


class StatementRow(Contract):
    reference: str = Field(min_length=1, max_length=200, repr=False)
    booked_on: date
    amount_minor: Minor
    currency: Literal['EUR'] = 'EUR'
    description: str = Field(max_length=200, repr=False)

    @field_validator('reference', 'description')
    @classmethod
    def printable(cls, value):
        if any(ord(c) < 32 or 127 <= ord(c) <= 159 for c in value):
            raise ValueError('invalid_text')
        return value

    @field_validator('booked_on')
    @classmethod
    def bounded_date(cls, value):
        if value == date.max:
            raise ValueError('invalid_date')
        return value


class NormalizedStatement(Contract):
    version: Literal[1] = 1
    source_format: Literal['wise_csv', 'canonical_csv', 'lhv_csv']
    account_reference: str | None = Field(default=None, max_length=200, repr=False)
    rows: list[StatementRow] = Field(min_length=1, max_length=MAX_IMPORT_ROWS, repr=False)

    @property
    def start(self):
        return min(row.booked_on for row in self.rows)

    @property
    def end_exclusive(self):
        return max(row.booked_on for row in self.rows) + timedelta(days=1)

    @property
    def repeated_reference_groups(self):
        return sum(count > 1 for count in Counter(row.reference for row in self.rows).values())

    def encode(self):
        return _json(self.model_dump(mode='json')).encode()

    @property
    def sha256(self):
        # Preserve multiplicity, including completely identical purchase rows.
        # CSV quoting, BOM, line endings and row ordering are not source changes.
        payload = self.model_dump(mode='json')
        # Adapter names are provenance, not a reason to duplicate the same rows.
        payload.pop('source_format')
        payload['rows'] = sorted(payload['rows'], key=_json)
        return hashlib.sha256(_json(payload).encode()).hexdigest()


def _json(value):
    return json.dumps(value, ensure_ascii=True, sort_keys=True, separators=(',', ':'))


def row_sha256(row):
    return hashlib.sha256(_json(row.model_dump(mode='json')).encode()).hexdigest()


def normalize_wise_csv(content):
    if not isinstance(content, bytes) or len(content) > MAX_UPLOAD_BYTES:
        raise StatementNormalizationError('file_too_large')
    parsed = preview_wise_csv(content)
    if not 1 <= len(parsed.rows) <= MAX_IMPORT_ROWS:
        raise StatementNormalizationError('invalid_rows')
    try:
        return NormalizedStatement(source_format='wise_csv', rows=[
            StatementRow(reference=row.reference, booked_on=row.booked_on,
                amount_minor=row.amount_minor, currency=row.currency, description=row.description)
            for row in parsed.rows
        ])
    except ValidationError:
        raise StatementNormalizationError('invalid_rows') from None


def normalize_canonical_csv(content):
    """Explicit UTF-8 CSV with ISO dates and signed integer EUR cents."""
    if not isinstance(content, bytes) or len(content) > MAX_UPLOAD_BYTES:
        raise StatementNormalizationError('file_too_large')
    try:
        reader = csv.reader(StringIO(content.decode('utf-8-sig'), newline=''), strict=True)
        header = next(reader, None)
        if not header or len(header) != len(CANONICAL_HEADER) or set(header) != set(CANONICAL_HEADER):
            raise StatementNormalizationError('unsupported_layout')
        indexes = [header.index(name) for name in CANONICAL_HEADER]
        rows = []
        for record in reader:
            if len(rows) >= MAX_IMPORT_ROWS:
                raise StatementNormalizationError('too_many_rows')
            if len(record) != len(header) or any(len(cell) > 8192 for cell in record):
                raise StatementNormalizationError('invalid_row')
            reference, booked, minor, currency, description = (record[i].strip() for i in indexes)
            if not re.fullmatch(r'[0-9]{4}-[0-9]{2}-[0-9]{2}', booked):
                raise StatementNormalizationError('invalid_date')
            if not re.fullmatch(r'-?(?:0|[1-9][0-9]{0,15})', minor):
                raise StatementNormalizationError('invalid_amount')
            rows.append(StatementRow(reference=reference, booked_on=date.fromisoformat(booked),
                amount_minor=int(minor), currency=currency, description=description))
        return NormalizedStatement(source_format='canonical_csv', rows=rows)
    except (UnicodeError, csv.Error, ValueError):
        raise StatementNormalizationError('invalid_canonical_csv') from None


def normalize_statement(content, source_format):
    if source_format == 'wise_csv':
        return normalize_wise_csv(content)
    if source_format == 'canonical_csv':
        return normalize_canonical_csv(content)
    raise StatementNormalizationError('unsupported_format')


def normalize_lhv_candidates(records, *, decimal_separator):
    """Offline candidate rows only: one account, explicit decimal separator."""
    rows = []
    account = None
    for fields in records:
        if len(rows) >= MAX_IMPORT_ROWS:
            raise StatementNormalizationError('too_many_rows')
        parsed = parse_lhv_candidate_row(fields, decimal_separator=decimal_separator)
        if account is not None and parsed.account != account:
            raise StatementNormalizationError('mixed_accounts')
        account = parsed.account
        try:
            rows.append(StatementRow(reference=parsed.reference, booked_on=parsed.booked_on,
                amount_minor=parsed.amount_minor, currency=parsed.currency, description=parsed.counterparty))
        except ValidationError:
            raise StatementNormalizationError('invalid_rows') from None
    try:
        return NormalizedStatement(source_format='lhv_csv', account_reference=account, rows=rows)
    except ValidationError:
        raise StatementNormalizationError('invalid_rows') from None


def decode_normalized(payload):
    """Read validated staged values, never invoke a source-file parser."""
    try:
        value = json.loads(payload)
        # Existing 15-minute previews remain confirmable across the migration.
        if isinstance(value, list):
            value = {'source_format': 'wise_csv', 'rows': [
                {'reference': f'legacy:{index}', 'booked_on': row['date'],
                    'amount_minor': row['amount'], 'description': row['description']}
                for index, row in enumerate(value)
            ]}
        return NormalizedStatement.model_validate(value)
    except (ValueError, TypeError, KeyError):
        raise StatementNormalizationError('invalid_staged_rows') from None
