"""Strict Wise CSV preview candidate. No publication or account matching.

Treat all descriptions and references as private. A provider reference is not
assumed unique; callers must resolve collisions before any publication.
"""
import csv
from dataclasses import dataclass, field
from datetime import datetime, date
from decimal import Decimal, InvalidOperation
from io import StringIO
import re

MAX_BYTES = 5 * 1024 * 1024
MAX_ROWS = 20000
MAX_COLUMNS = 100
MAX_CELL = 8192
REQUIRED = ('TransferWise ID', 'Date', 'Amount', 'Currency', 'Description')
AMOUNT = re.compile(r'-?(?:0|[1-9][0-9]{0,13})(?:\.[0-9]{1,2})?\Z', re.ASCII)
DAY = re.compile(r'[0-9]{2}-[0-9]{2}-[0-9]{4}\Z', re.ASCII)

class WiseStatementError(ValueError):
    """Safe reason code, never source cell values."""

@dataclass(frozen=True, repr=False)
class WiseRow:
    reference: str = field(repr=False)
    booked_on: date
    amount_minor: int
    currency: str
    description: str = field(repr=False)

@dataclass(frozen=True, repr=False)
class WisePreview:
    rows: tuple[WiseRow, ...]
    conflicting_references: int


def preview_wise_csv(content: bytes) -> WisePreview:
    if not isinstance(content, bytes) or len(content) > MAX_BYTES:
        raise WiseStatementError('file_too_large')
    try:
        text = content.decode('utf-8-sig')
    except UnicodeDecodeError:
        raise WiseStatementError('invalid_encoding') from None
    try:
        reader = csv.reader(StringIO(text, newline=''), strict=True)
        header = next(reader, None)
        if not header or len(header) > MAX_COLUMNS or len(set(header)) != len(header) or any(name not in header for name in REQUIRED):
            raise WiseStatementError('unsupported_layout')
        indexes = [header.index(name) for name in REQUIRED]
        rows = []
        counts = {}
        for record in reader:
            if len(rows) >= MAX_ROWS:
                raise WiseStatementError('too_many_rows')
            if len(record) != len(header) or any(len(cell) > MAX_CELL for cell in record):
                raise WiseStatementError('invalid_row')
            reference, raw_date, raw_amount, currency, description = (record[i].strip() for i in indexes)
            if not reference or len(reference) > 200 or not DAY.fullmatch(raw_date):
                raise WiseStatementError('invalid_reference_or_date')
            try:
                booked_on = datetime.strptime(raw_date, '%d-%m-%Y').date()
            except ValueError:
                raise WiseStatementError('invalid_date') from None
            if len(description) > 200 or any(ord(c) < 32 or 127 <= ord(c) <= 159 for c in description):
                raise WiseStatementError('invalid_description')
            if currency != 'EUR':
                raise WiseStatementError('unsupported_currency')
            if not AMOUNT.fullmatch(raw_amount):
                raise WiseStatementError('invalid_amount')
            try:
                minor = int(Decimal(raw_amount) * 100)
            except (ValueError, InvalidOperation):
                raise WiseStatementError('invalid_amount') from None
            if abs(minor) > 2**53-1:
                raise WiseStatementError('amount_out_of_range')
            rows.append(WiseRow(reference, booked_on, minor, currency, description))
            counts[reference] = counts.get(reference, 0) + 1
        return WisePreview(tuple(rows), sum(1 for n in counts.values() if n > 1))
    except csv.Error:
        raise WiseStatementError('invalid_csv') from None
