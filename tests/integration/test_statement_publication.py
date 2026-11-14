"""Opt-in PostgreSQL acceptance: statements and simulated banks, no hosted models."""
from concurrent.futures import ThreadPoolExecutor
import csv
from datetime import datetime, timezone
from io import StringIO
import json
from pathlib import Path
from time import perf_counter
from uuid import UUID, uuid4

import psycopg
import pytest

from app.bank_adapter import BankTransactionV1
from app.database import TrustedScope, tenant_transaction
from app.identity import AuthError
from app import statement_normalization, statement_routes
from app.synthetic_banks import SyntheticBank
from identity_support import ORIGIN, authenticated_app, login
from test_bank_publication import synchronize
from test_bank_routes import finish, headers, start

FIXTURES = Path(__file__).resolve().parents[1] / 'fixtures/statements'
PERIOD = {'start':'2026-10-01', 'end_exclusive':'2026-11-01'}


def auth(client, profile='aino'):
    session = login(client, profile).json()
    return {'Origin':ORIGIN, 'X-CSRF-Token':session['csrf_token']}


def preview(client, auth, content=None, source_format='wise_csv', account=None):
    if content is None:
        content = (FIXTURES / ('wise-equivalence.csv' if source_format == 'wise_csv' else 'canonical-equivalence.csv')).read_text()
    body = {'format':source_format, 'csv':content}
    if account is not None:
        body['account_id'] = str(account)
    response = client.post('/v1/statements/preview', json=body, headers=auth)
    assert response.status_code == 200, response.text
    return response.json()


def confirm(client, auth, stage):
    response = client.post('/v1/statements/confirm', json={'preview_id':stage['id']}, headers=auth)
    assert response.status_code == 200, response.text
    return response.json()


def facts(database, owner):
    with psycopg.connect(database['admin']) as connection:
        return tuple(connection.execute(sql, owner[:2]).fetchone()[0] for sql in (
            'SELECT count(*) FROM moneylens.accounts WHERE tenant_id=%s AND owner_user_id=%s',
            'SELECT count(*) FROM moneylens.transactions WHERE tenant_id=%s AND owner_user_id=%s',
            'SELECT count(*) FROM moneylens.statement_import_receipts WHERE tenant_id=%s AND owner_user_id=%s',
            'SELECT data_version FROM moneylens.user_state WHERE tenant_id=%s AND owner_user_id=%s'))


def canonical_csv(rows):
    stream = StringIO(newline='')
    writer = csv.writer(stream)
    writer.writerow(['reference','booked_on','amount_minor','currency','description'])
    for row in rows:
        writer.writerow([row['reference'],row['booked_on'],row['amount_minor'],row['currency'],row['merchant']])
    return stream.getvalue()


def economic(rows):
    return sorted(tuple(row[key] for key in ('booked_on','amount_minor','currency','merchant',
        'status','category','basket','economic_flow')) for row in rows)


def snapshot(client, accounts=None):
    params = dict(PERIOD)
    if accounts is not None:
        params['account_id'] = accounts
    responses = [client.get(path, params=params) for path in
        ('/v1/ledger/transactions','/v1/ledger/inventory','/v1/analysis/spending')]
    assert all(response.status_code == 200 for response in responses), [r.text for r in responses]
    ledger, inventory, spending = [r.json() for r in responses]
    assert spending['net_minor'] == 0  # Statement purpose remains unreviewed.
    return ledger, inventory


def test_cross_format_repeats_reuse_receipt_and_keep_identical_purchases(database, owners, monkeypatch):
    with authenticated_app(database, owners, statement_imports_enabled=True) as (client, app, config):
        h = auth(client)
        stage = preview(client, h)
        assert stage['account_id'] is None and stage['account'] == 'Wise CSV'
        assert stage['account_identity'] == 'unverified' and stage['overlap'] == 'none'
        assert stage['period_basis'] == 'transaction_dates' and stage['repeated_reference_groups'] == 1
        assert facts(database, owners[0]) == (1,0,0,1)
        # Parsing is forbidden after preview, including when opening a ledger view.
        parser = statement_routes.normalize_statement
        monkeypatch.setattr(statement_routes, 'normalize_statement', lambda *args: pytest.fail('source reparsed'))
        with monkeypatch.context() as no_source_parser:
            no_source_parser.setattr(statement_normalization, 'preview_wise_csv', lambda *args: pytest.fail('CSV reparsed'))
            result = confirm(client, h, stage)
        assert confirm(client, h, stage) == result
        ledger, inventory = snapshot(client, [result['account_id']])
        assert len(ledger['rows']) == 6 and inventory['period_unreviewed_outgoing_minor'] == 3703
        assert sum(row['merchant'] == 'Synthetic market' for row in ledger['rows']) == 2
        monkeypatch.setattr(statement_routes, 'normalize_statement', parser)
        equivalent = (FIXTURES / 'canonical-equivalence.csv').read_text()
        assert preview(client, h, equivalent, 'canonical_csv') == result
        lines = equivalent.splitlines()
        reordered = '\ufeff' + '\r\n'.join([lines[0], *reversed(lines[1:])]) + '\r\n'
        assert preview(client, h, reordered, 'canonical_csv') == result
        assert facts(database, owners[0]) == (2,6,1,2)
        with psycopg.connect(database['admin']) as connection:
            saved = connection.execute('''SELECT count(*),count(DISTINCT t.source_id),count(DISTINCT t.id),
                count(t.source_payload_hash),sum(t.amount_minor),min(r.source_format)
                FROM moneylens.transactions t JOIN moneylens.statement_import_receipts r
                  ON (t.tenant_id,t.owner_user_id,t.statement_receipt_id,t.account_id)=(r.tenant_id,r.owner_user_id,r.id,r.account_id)
                WHERE t.tenant_id=%s AND t.owner_user_id=%s''', owners[0][:2]).fetchone()
            assert saved == (6,6,6,6,96327,'wise_csv')
            assert connection.execute('SELECT count(*) FROM moneylens.statement_previews WHERE tenant_id=%s AND owner_user_id=%s', owners[0][:2]).fetchone() == (0,)


def test_preview_is_session_bound_and_owned_account_cannot_be_substituted(database, owners):
    with authenticated_app(database, owners, statement_imports_enabled=True) as (client, app, config):
        h = auth(client)
        stage = preview(client, h, account=owners[0][2])
        assert stage['account_id'] == str(owners[0][2]) and stage['account'] == 'Synthetic account'
        for account in (owners[1][2], owners[2][2], uuid4()):
            response = client.post('/v1/statements/preview', json={'format':'wise_csv',
                'csv':(FIXTURES / 'wise-equivalence.csv').read_text(), 'account_id':str(account)}, headers=h)
            assert response.status_code == 404
        h = auth(client)
        assert client.post('/v1/statements/confirm', json={'preview_id':stage['id']}, headers=h).status_code == 404
        other = auth(client, 'mika')
        assert client.post('/v1/statements/confirm', json={'preview_id':stage['id']}, headers=other).status_code == 404
        own = confirm(client, other, preview(client, other))
        first = auth(client)
        assert client.get('/v1/ledger/transactions', params={**PERIOD,'account_id':own['account_id']}).status_code == 404
        assert facts(database, owners[0]) == (1,0,0,1)


def test_overlap_is_account_scoped_and_rechecked_at_confirmation(database, owners):
    with authenticated_app(database, owners, statement_imports_enabled=True) as (client, app, config):
        h = auth(client)
        first = preview(client, h)
        changed = (FIXTURES / 'canonical-equivalence.csv').read_text().replace('purchase-repeat','another-purchase')
        stale = preview(client, h, changed, 'canonical_csv')
        result = confirm(client, h, first)
        assert client.post('/v1/statements/confirm',json={'preview_id':stale['id']},headers=h).status_code == 409
        assert client.post('/v1/statements/preview',json={'format':'canonical_csv','csv':changed},headers=h).status_code == 409
        # A separate explicitly selected account can cover the same dates.
        second = confirm(client,h,preview(client,h,changed,'canonical_csv',owners[0][2]))
        assert second['account_id'] != result['account_id']
        selected, _ = snapshot(client,[result['account_id']])
        combined, _ = snapshot(client)
        assert len(selected['rows']) == 6 and len(combined['rows']) == 12
        assert facts(database,owners[0]) == (2,12,2,3)


def test_publication_failure_rolls_back_rows_account_receipt_and_version(database, owners, monkeypatch):
    with authenticated_app(database, owners, statement_imports_enabled=True) as (client, app, config):
        h = auth(client)
        stage = preview(client,h,source_format='canonical_csv')
        original = statement_routes.publish_rows
        def fail_after_insert(*args):
            original(*args)
            raise AuthError('INVALID_IMPORT_COMMAND',409)
        monkeypatch.setattr(statement_routes,'publish_rows',fail_after_insert)
        response = client.post('/v1/statements/confirm',json={'preview_id':stage['id']},headers=h)
        assert response.status_code == 409
        assert facts(database,owners[0]) == (1,0,0,1)
        monkeypatch.setattr(statement_routes,'publish_rows',original)
        assert confirm(client,h,stage)['count'] == 6
        assert facts(database,owners[0]) == (2,6,1,2)


@pytest.mark.parametrize('source_format', ['wise_csv','canonical_csv'])
@pytest.mark.parametrize('count', [700,1000])
def test_batch_publication_at_supported_scale(database,owners,source_format,count):
    if source_format == 'wise_csv':
        content = 'TransferWise ID,Date,Amount,Currency,Description\n' + 'same,03-10-2026,-12.34,EUR,Synthetic purchase\n' * count
    else:
        content = 'reference,booked_on,amount_minor,currency,description\n' + 'same,2026-10-03,-1234,EUR,Synthetic purchase\n' * count
    assert len(content.encode()) <= 65536
    with authenticated_app(database,owners,statement_imports_enabled=True) as (client,app,config):
        h = auth(client)
        began = perf_counter(); stage = preview(client,h,content,source_format); preview_ms = (perf_counter()-began)*1000
        began = perf_counter(); result = confirm(client,h,stage); confirm_ms = (perf_counter()-began)*1000
        print(f'statement_publication format={source_format} rows={count} preview_ms={preview_ms:.1f} confirm_ms={confirm_ms:.1f}')
        assert result['count'] == count and facts(database,owners[0]) == (2,count,1,2)
        with psycopg.connect(database['admin']) as connection:
            assert connection.execute('''SELECT count(DISTINCT source_id),sum(amount_minor),count(statement_receipt_id)
                FROM moneylens.transactions WHERE tenant_id=%s AND owner_user_id=%s''',owners[0][:2]).fetchone() == (count,-1234*count,count)


def test_concurrent_confirmations_publish_once(database,owners):
    with authenticated_app(database,owners,statement_imports_enabled=True) as (client,app,config):
        h = auth(client)
        stages = [preview(client,h) for _ in range(2)]
        with ThreadPoolExecutor(max_workers=2) as workers:
            results = list(workers.map(lambda stage: confirm(client,h,stage),stages))
        assert results[0] == results[1]
        assert facts(database,owners[0]) == (2,6,1,2)


def test_csv_and_simulated_bank_persist_equivalent_rows_and_account_scopes(database,owners,monkeypatch):
    fixture = json.loads((FIXTURES / 'source-equivalence.json').read_text())
    def dataset(adapter,session):
        records = fixture['bank_rows'] if adapter.institution == 's-bank-demo' else fixture['extra_account_rows']
        return [BankTransactionV1(**row,account_reference=adapter.account(session).reference,revision=1,
            status='booked',category='unclassified',basket='unresolved',economic_flow='unknown') for row in records]
    monkeypatch.setattr(SyntheticBank,'dataset',dataset)
    with authenticated_app(database,owners,statement_imports_enabled=True) as (client,app,config):
        h = auth(client)
        csv_account = confirm(client,h,preview(client,h))['account_id']
        confirm(client,h,preview(client,h,canonical_csv(fixture['extra_account_rows']),'canonical_csv',owners[0][2]))
        csv_selected, csv_inventory = snapshot(client,[csv_account])
        csv_union, csv_union_inventory = snapshot(client)
        # The other owner's real simulator path includes consent, fetch jobs,
        # sealed staging and restricted-role atomic bank publication.
        now = datetime.now(timezone.utc)
        app.state.bank_clock = app.state.planning_clock = lambda: now
        h = headers(client,'mika')
        user = app.state.identity.resolve(client.cookies.get('moneylens_session'))
        bank_accounts = []
        for index, bank in enumerate(('s-bank-demo','north-demo')):
            started = start(client,h,bank,f'equivalence-{index}')
            response = finish(client,h,started,key=f'complete-{index}')
            assert response.status_code == 200,response.text
            synchronize(database,client,app,config,h,started,user,key=f'sync-{index}',now=now)
            with psycopg.connect(database['admin']) as connection:
                bank_accounts.append(str(connection.execute('''SELECT account_id FROM moneylens.account_source_aliases
                    WHERE tenant_id=%s AND owner_user_id=%s AND connection_id=%s''',
                    (*owners[1][:2],UUID(started['connection']['id']))).fetchone()[0]))
        bank_selected, bank_inventory = snapshot(client,[bank_accounts[0]])
        bank_union, bank_union_inventory = snapshot(client)
        assert economic(csv_selected['rows']) == economic(bank_selected['rows'])
        assert economic(csv_union['rows']) == economic(bank_union['rows'])
        expected = fixture['expected']
        for rows, inventory, scope in ((csv_selected['rows'],csv_inventory,'selected'),
            (bank_selected['rows'],bank_inventory,'selected'),(csv_union['rows'],csv_union_inventory,'union'),
            (bank_union['rows'],bank_union_inventory,'union')):
            assert len(rows) == inventory['period_booked_count'] == expected[scope+'_count']
            assert sum(row['amount_minor'] for row in rows) == expected[scope+'_cash_net_minor']
            assert inventory['period_unreviewed_outgoing_minor'] == expected[scope+'_unreviewed_outgoing_minor']
        assert csv_selected['scope']['scope_kind'] == bank_selected['scope']['scope_kind'] == 'selected_accounts'
        assert csv_union['scope']['scope_kind'] == bank_union['scope']['scope_kind'] == 'included_accounts'


def test_repeat_import_preserves_owner_classification_and_source_binding(database,owners):
    with authenticated_app(database,owners,statement_imports_enabled=True) as (client,app,config):
        h = auth(client)
        stage = preview(client,h)
        result = confirm(client,h,stage)
        ledger, _ = snapshot(client,[result['account_id']])
        row = next(row for row in ledger['rows'] if row['merchant'] == 'Synthetic market')
        reviewed = client.post('/v1/ledger/transactions/'+row['id']+'/classification',headers=h,json={
            'expected_data_version':ledger['scope']['data_version'],'economic_flow':'expense',
            'category':'groceries','basket':'everyday'})
        assert reviewed.status_code == 200,reviewed.text
        before = facts(database,owners[0])
        with psycopg.connect(database['admin']) as connection:
            identity = connection.execute('''SELECT id,account_id,source_id,statement_receipt_id,source_payload_hash,source_revision
                FROM moneylens.transactions WHERE tenant_id=%s AND owner_user_id=%s AND id=%s''',
                (*owners[0][:2],UUID(row['id']))).fetchone()
        assert confirm(client,h,stage) == result
        assert preview(client,h) == result
        assert preview(client,h,source_format='canonical_csv') == result
        assert facts(database,owners[0]) == before
        response = client.get('/v1/ledger/transactions',params={**PERIOD,'account_id':result['account_id']})
        saved = next(saved for saved in response.json()['rows'] if saved['id'] == row['id'])
        assert (saved['category'],saved['basket'],saved['economic_flow']) == ('groceries','everyday','expense')
        with psycopg.connect(database['admin']) as connection:
            assert connection.execute('''SELECT id,account_id,source_id,statement_receipt_id,source_payload_hash,source_revision
                FROM moneylens.transactions WHERE tenant_id=%s AND owner_user_id=%s AND id=%s''',
                (*owners[0][:2],UUID(row['id']))).fetchone() == identity
            assert connection.execute('SELECT count(*) FROM moneylens.classification_corrections WHERE transaction_id=%s',
                (UUID(row['id']),)).fetchone() == (1,)


def test_database_rejects_receipt_account_owner_and_provider_mismatches(database,owners):
    with authenticated_app(database,owners,statement_imports_enabled=True) as (client,app,config):
        h = auth(client)
        first = confirm(client,h,preview(client,h))
        other = auth(client,'mika')
        second = confirm(client,other,preview(client,other))
        owner = owners[0][:2]
        with psycopg.connect(database['runtime'],autocommit=True) as connection:
            with pytest.raises(psycopg.errors.ForeignKeyViolation):
                with tenant_transaction(connection,TrustedScope(*owner)):
                    connection.execute('''UPDATE moneylens.transactions SET account_id=%s
                        WHERE tenant_id=%s AND owner_user_id=%s AND statement_receipt_id=%s''',
                        (owners[0][2],*owner,UUID(first['id'])))
            with pytest.raises(psycopg.errors.ForeignKeyViolation):
                with tenant_transaction(connection,TrustedScope(*owner)):
                    connection.execute('''UPDATE moneylens.transactions SET statement_receipt_id=%s
                        WHERE tenant_id=%s AND owner_user_id=%s AND statement_receipt_id=%s''',
                        (UUID(second['id']),*owner,UUID(first['id'])))
            with pytest.raises(psycopg.errors.CheckViolation):
                with tenant_transaction(connection,TrustedScope(*owner)):
                    connection.execute('''UPDATE moneylens.transactions SET connection_id=%s
                        WHERE tenant_id=%s AND owner_user_id=%s AND statement_receipt_id=%s''',
                        (uuid4(),*owner,UUID(first['id'])))
        assert facts(database,owners[0]) == (2,6,1,2)
