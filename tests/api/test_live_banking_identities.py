from uuid import UUID

from app.live_banking_publication import _internal_transfer_ids, _transaction_identity


ACCOUNT = UUID("00000000-0000-0000-0000-000000000001")


def transaction(**changes):
    value = {
        "reference": "provider-id",
        "booked_on": "2026-11-01",
        "amount_minor": -1250,
        "merchant": "Example market",
    }
    value.update(changes)
    return value


def test_missing_provider_id_is_stable_across_repeated_imports():
    row = transaction(reference="")
    assert _transaction_identity(ACCOUNT, row, 0) == _transaction_identity(ACCOUNT, row, 0)
    assert _transaction_identity(ACCOUNT, row, 0) != _transaction_identity(ACCOUNT, row, 1)


def test_duplicate_provider_ids_are_disambiguated_without_changing_unique_id():
    first = transaction(amount_minor=-1250)
    second = transaction(amount_minor=-1260)
    first_id = _transaction_identity(ACCOUNT, first, 0)
    second_id = _transaction_identity(ACCOUNT, second, 1)
    assert first_id != second_id
    assert first_id == _transaction_identity(ACCOUNT, first, 0)
    assert second_id == _transaction_identity(ACCOUNT, second, 1)


def test_overlapping_windows_reuse_the_same_identity():
    row = transaction(reference="overlap")
    assert _transaction_identity(ACCOUNT, row, 0) == _transaction_identity(ACCOUNT, row, 0)


def test_pending_rows_are_not_classified_by_identity_as_booked():
    booked = transaction(reference="same", status="booked")
    pending = transaction(reference="same", status="pending")
    assert _transaction_identity(ACCOUNT, booked, 0) == _transaction_identity(ACCOUNT, pending, 0)


def test_opposite_rows_across_consented_accounts_are_internal_transfers():
    other = UUID("00000000-0000-0000-0000-000000000002")
    rows = [
        {"account_id": ACCOUNT, "account_name": "Main", "currency": "EUR",
         "transaction_id": "debit", "txn": transaction(reference="debit", amount_minor=-5000)},
        {"account_id": other, "account_name": "Savings", "currency": "EUR",
         "transaction_id": "credit", "txn": transaction(reference="credit", amount_minor=5000, booked_on="2026-11-03")},
    ]
    assert _internal_transfer_ids(rows) == {"debit", "credit"}
