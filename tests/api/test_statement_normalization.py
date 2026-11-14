from datetime import date
import json
from pathlib import Path
from uuid import uuid4

import pytest

from app.bank_adapter import BankTransactionV1
from app.statement_normalization import (
    MAX_IMPORT_ROWS, MAX_UPLOAD_BYTES, StatementNormalizationError, decode_normalized,
    normalize_canonical_csv, normalize_lhv_candidates, normalize_statement, normalize_wise_csv,
)
from app.statement_routes import publish_rows
from app.statement_wise import WiseStatementError

FIXTURES = Path(__file__).resolve().parents[1] / 'fixtures/statements'
HEADER = 'reference,booked_on,amount_minor,currency,description\n'


def economic(row):
    return (str(row.booked_on), row.amount_minor, row.currency,
        row.description if hasattr(row, 'description') else row.merchant)


def test_csv_and_simulated_bank_fixtures_have_identical_economic_rows():
    wise = normalize_wise_csv((FIXTURES / 'wise-equivalence.csv').read_bytes())
    canonical = normalize_canonical_csv((FIXTURES / 'canonical-equivalence.csv').read_bytes())
    fixture = json.loads((FIXTURES / 'source-equivalence.json').read_text())
    bank = [BankTransactionV1(**row, account_reference='synthetic-account', revision=1,
        status='booked', category='unclassified', basket='unresolved', economic_flow='unknown')
        for row in fixture['bank_rows']]
    assert sorted(map(economic, wise.rows)) == sorted(map(economic, canonical.rows)) == sorted(map(economic, bank))
    assert wise.sha256 == canonical.sha256
    assert wise.repeated_reference_groups == canonical.repeated_reference_groups == 1
    assert len(wise.rows) == fixture['expected']['selected_count']
    assert sum(row.amount_minor for row in wise.rows) == fixture['expected']['selected_cash_net_minor']
    assert sum(-row.amount_minor for row in wise.rows if row.amount_minor < 0) == fixture['expected']['selected_unreviewed_outgoing_minor']
    assert (wise.start, wise.end_exclusive) == (date(2026, 10, 3), date(2026, 10, 7))
    assert 'purchase-repeat' not in repr(wise) and 'Synthetic' not in repr(wise.rows[0])


def test_equivalent_csv_encodings_and_row_order_deduplicate_without_losing_multiplicity():
    content = (FIXTURES / 'canonical-equivalence.csv').read_text()
    lines = content.splitlines()
    document = normalize_canonical_csv(content.encode())
    reordered = ('\ufeff' + '\r\n'.join([lines[0], *reversed(lines[1:])]) + '\r\n').encode()
    assert normalize_canonical_csv(reordered).sha256 == document.sha256
    assert normalize_canonical_csv(('\n'.join(lines[:-1]) + '\n').encode()).sha256 != document.sha256
    assert normalize_canonical_csv(content.replace('purchase-repeat', 'different-reference', 1).encode()).sha256 != document.sha256
    assert sum(row.description == 'Synthetic market' for row in document.rows) == 2
    assert decode_normalized(document.encode()) == document


@pytest.mark.parametrize('separator', ['.', ','])
def test_lhv_candidate_fields_use_same_normalized_contract_offline(separator):
    wise = normalize_wise_csv((FIXTURES / 'wise-equivalence.csv').read_bytes())
    records = []
    for row in wise.rows:
        amount = ('-' if row.amount_minor < 0 else '') + f'{abs(row.amount_minor)//100}{separator}{abs(row.amount_minor)%100:02}'
        records.append(['EE000000000000000000', '1', str(row.booked_on), '', row.description,
            'D' if row.amount_minor < 0 else 'C', amount, '', '', '', 'EUR', '', '', '', '', row.reference])
    candidate = normalize_lhv_candidates(records, decimal_separator=separator)
    assert list(map(economic, candidate.rows)) == list(map(economic, wise.rows))
    assert candidate.source_format == 'lhv_csv' and candidate.account_reference == records[0][0]
    records[-1][0] = 'EE111111111111111111'
    with pytest.raises(StatementNormalizationError, match='mixed_accounts'):
        normalize_lhv_candidates(records, decimal_separator=separator)


@pytest.mark.parametrize('row', [
    'ref,2026-10-03,-1.00,EUR,private', 'ref,2026-10-03,1e2,EUR,private',
    'ref,2026-10-03,+1,EUR,private', 'ref,2026-10-03,01,EUR,private',
    'ref,2026-10-03,NaN,EUR,private', 'ref,2026-10-03,9007199254740992,EUR,private',
    'ref,2026-10-03,1,USD,private', 'ref,2026-02-31,1,EUR,private',
    'ref,03-10-2026,1,EUR,private', 'ref,9999-12-31,1,EUR,private',
    ',2026-10-03,1,EUR,private', 'bad\x00ref,2026-10-03,1,EUR,private',
    'ref,2026-10-03,1,EUR,bad\x00private', 'ref,2026-10-03,1,EUR,' + 'x'*201,
    'ref,2026-10-03,1,EUR,"unterminated', 'ref,2026-10-03,1,EUR,private,extra',
])
def test_canonical_rejects_ambiguous_values_without_disclosing_source(row):
    with pytest.raises(StatementNormalizationError) as error:
        normalize_canonical_csv((HEADER + row + '\n').encode())
    assert 'private' not in str(error.value)


@pytest.mark.parametrize('content', [b'', b'%PDF-1.7\n', b'\xff',
    b'reference,reference,amount_minor,currency,description\n',
    b'reference,booked_on,amount_minor,currency,description,other\n'])
def test_canonical_rejects_missing_or_unknown_layouts(content):
    with pytest.raises(StatementNormalizationError):
        normalize_canonical_csv(content)


@pytest.mark.parametrize('source_format', ['wise_csv', 'canonical_csv'])
def test_public_formats_enforce_same_size_and_row_limits(source_format):
    header, record = (('TransferWise ID,Date,Amount,Currency,Description\n', 'ref,03-10-2026,-0.01,EUR,x\n')
        if source_format == 'wise_csv' else (HEADER, 'ref,2026-10-03,-1,EUR,x\n'))
    assert len(normalize_statement((header + record * MAX_IMPORT_ROWS).encode(), source_format).rows) == MAX_IMPORT_ROWS
    for content in ((header + record * (MAX_IMPORT_ROWS+1)).encode(), b'x' * (MAX_UPLOAD_BYTES+1)):
        with pytest.raises((StatementNormalizationError, WiseStatementError)):
            normalize_statement(content, source_format)
    with pytest.raises(StatementNormalizationError):
        normalize_statement(header.encode(), source_format)


@pytest.mark.parametrize('amount', ['1.5', 'true', '9007199254740992'])
def test_staged_payload_rejects_float_boolean_and_out_of_range_cents(amount):
    payload = '{"source_format":"canonical_csv","rows":[{"reference":"r","booked_on":"2026-10-03","amount_minor":' + amount + ',"description":"private"}]}'
    with pytest.raises(StatementNormalizationError, match='invalid_staged_rows'):
        decode_normalized(payload)


def test_existing_encrypted_preview_shape_remains_readable_without_csv_parser():
    document = decode_normalized(b'[{"date":"2026-10-03","amount":-1234,"description":"Synthetic"}]')
    assert document.source_format == 'wise_csv' and document.rows[0].amount_minor == -1234


def test_publication_sends_one_insert_for_1000_rows_and_keeps_identical_purchases():
    class Capture:
        def __init__(self):
            self.calls = []

        def execute(self, sql, params):
            self.calls.append((sql, params))

    document = normalize_canonical_csv((HEADER + 'same,2026-10-03,-1234,EUR,Synthetic\n' * MAX_IMPORT_ROWS).encode())
    connection = Capture()
    publish_rows(connection, (uuid4(), uuid4()), uuid4(), uuid4(), 'a'*64, document)
    assert len(connection.calls) == 1
    sql, params = connection.calls[0]
    assert 'INSERT INTO moneylens.transactions' in sql and 'jsonb_to_recordset' in sql
    rows = params[-1].obj
    assert len(rows) == MAX_IMPORT_ROWS and len({row['id'] for row in rows}) == MAX_IMPORT_ROWS
    assert len({row['source_id'] for row in rows}) == MAX_IMPORT_ROWS
    assert {row['amount_minor'] for row in rows} == {-1234}
    assert len({row['source_payload_hash'] for row in rows}) == 1
