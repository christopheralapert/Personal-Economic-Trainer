"""Explicit owned reviews. Source identity, financial facts and hashes stay unchanged."""
from typing import Literal
from uuid import UUID, uuid4

from fastapi import Depends, Request
from pydantic import Field, StrictInt, model_validator
from psycopg.types.json import Jsonb
from psycopg.rows import dict_row

from .auth_routes import write_principal
from .contracts import Contract
from .identity import AuthError, authorized_transaction
from .ledger import Ledger, LedgerFilterV1, LedgerRowV1
from .ledger_routes import router

Category = Literal["taxi", "dining", "groceries", "housing", "repairs", "coffee", "other",
    "utilities", "phone", "insurance", "transport", "health", "pharmacy", "home_tech",
    "lifestyle", "entertainment", "travel"]
Flow = Literal["expense", "refund", "income", "internal_transfer", "liability_settlement", "unknown"]
Basket = Literal["mandatory_regular", "mandatory_irregular", "everyday", "unresolved"]


class ClassificationReviewV1(Contract):
    expected_data_version: StrictInt = Field(ge=1, le=2**53-1)
    economic_flow: Flow
    category: Category | None = None
    basket: Basket = "unresolved"

    @model_validator(mode="after")
    def explicit_consumption(self):
        if self.economic_flow in ("expense", "refund"):
            if self.category is None or self.basket == "unresolved":
                raise ValueError("Choose a category and a spending basket")
        elif self.category is not None or self.basket != "unresolved":
            raise ValueError("Non-spending flows do not belong to a spending basket")
        return self


class ClassificationResultV1(Contract):
    row: LedgerRowV1
    data_version: int


@router.post("/v1/ledger/transactions/{transaction_id}/classification", response_model=ClassificationResultV1)
def review(transaction_id: UUID, body: ClassificationReviewV1, request: Request, user=Depends(write_principal)):
    owner = (user.scope.tenant_id, user.scope.user_id)
    with request.app.state.pools.finance.connection() as connection:
        with authorized_transaction(connection, user, write=True):
            # Resolve the persisted row under RLS, then recheck its included account/consent
            # using exactly the ledger's access path. Native immutable publications are not editable here.
            source = connection.execute("""SELECT account_id,booked_on,currency,amount_minor,status
                FROM moneylens.transactions WHERE tenant_id=%s AND owner_user_id=%s AND id=%s FOR UPDATE""",
                (*owner, transaction_id)).fetchone()
            if source is None:
                raise AuthError("NOT_FOUND", 404)
            account, day, currency, amount, status = source
            if status != "booked":
                raise AuthError("CLASSIFICATION_REQUIRES_BOOKED", 422)
            from datetime import timedelta
            now = request.app.state.bank_clock() if hasattr(request.app.state, "bank_clock") else None
            Ledger(connection, user, LedgerFilterV1(start=day, end_exclusive=day+timedelta(days=1),
                account_ids=[account], currency=currency), expected_data_version=body.expected_data_version, now=now)
            if (body.economic_flow == "expense" and amount >= 0) or (body.economic_flow in ("income", "refund") and amount <= 0):
                raise AuthError("CLASSIFICATION_DIRECTION_MISMATCH", 422)
            category = body.category or "unclassified"
            # Append-only review history, including later corrections and 'not sure'.
            connection.execute("""INSERT INTO moneylens.classification_corrections
                (tenant_id,owner_user_id,id,transaction_id,category,basket,essentiality,recurrence,reason,rule_version,economic_flow)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,'Explicit owner review','owner-review.v1',%s)""",
                (*owner, uuid4(), transaction_id, category, body.basket,
                 "essential" if body.basket.startswith("mandatory_") else "flexible" if body.basket == "everyday" else "unknown",
                 "regular" if body.basket == "mandatory_regular" else "irregular" if body.basket == "mandatory_irregular" else "unknown",
                 body.economic_flow))
            connection.execute("""UPDATE moneylens.transactions SET category=%s,basket=%s,economic_flow=%s
                WHERE tenant_id=%s AND owner_user_id=%s AND id=%s""",
                (category, body.basket, body.economic_flow, *owner, transaction_id))
            if body.economic_flow != "internal_transfer":
                connection.execute("""UPDATE moneylens.transfer_links SET state='rejected'
                    WHERE tenant_id=%s AND owner_user_id=%s AND (debit_id=%s OR credit_id=%s)""",
                    (*owner, transaction_id, transaction_id))
            version = connection.execute("""UPDATE moneylens.user_state SET data_version=data_version+1
                WHERE tenant_id=%s AND owner_user_id=%s RETURNING data_version""", owner).fetchone()[0]
            connection.execute("""INSERT INTO moneylens.audit_events
                (tenant_id,owner_user_id,id,action,resource_id,trace_id,metadata)
                VALUES (%s,%s,%s,'transaction.classified',%s,%s,%s)""",
                (*owner, uuid4(), transaction_id, uuid4(), Jsonb({"rule_version":"owner-review.v1"})))
            with connection.cursor(row_factory=dict_row) as cursor:
                row = cursor.execute("""SELECT id,account_id,amount_minor,currency,booked_on,status,merchant,category,basket,economic_flow
                    FROM moneylens.transactions WHERE tenant_id=%s AND owner_user_id=%s AND id=%s""", (*owner, transaction_id)).fetchone()
            return ClassificationResultV1(row=LedgerRowV1.model_validate(row), data_version=version)
