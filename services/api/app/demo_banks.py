"""Public, database-free rehearsal of the existing synthetic AIS adapters.

No real identity, provider, ledger, credentials or bank URL is reachable here.
The short-lived token is simulation state, never a private API session.
"""
from dataclasses import replace
from datetime import date, datetime, timedelta, timezone
import json
from secrets import token_hex
from typing import Literal
from uuid import UUID, uuid4

from cryptography.fernet import Fernet, InvalidToken
from fastapi import APIRouter, HTTPException
from pydantic import Field
from .bank_adapter import BankSession, BankError, BankId
from .synthetic_registry import SYNTHETIC_INSTITUTIONS
from .contracts import Contract
from .database import TrustedScope
from .synthetic_banks import SyntheticBank

router = APIRouter()
_cipher = Fernet(Fernet.generate_key())
_cursor_secret = token_hex(32)
_scope = TrustedScope(UUID("00000000-0000-0000-0000-00000000de01"), UUID("00000000-0000-0000-0000-00000000de02"))
_as_of = datetime(2026, 11, 4, 10, tzinfo=timezone.utc)


class DemoBankCommand(Contract):
    action: Literal["select", "approve", "cancel", "import"]
    institution: BankId
    token: str | None = Field(default=None, max_length=2048)


def adapter(institution, session):
    def guard(candidate, purpose):
        if candidate != session or candidate.scope != _scope:
            raise BankError("invalid_simulation_scope")
        if purpose == "read" and not candidate.account_references:
            raise BankError("consent_not_active")
    return SyntheticBank(institution, guard, _cursor_secret, clock=lambda: _as_of)


@router.get("/v1/demo/banks")
def directory():
    return [adapter(key, None).capabilities() for key in SYNTHETIC_INSTITUTIONS]


@router.post("/v1/demo/banks/command")
def command(body: DemoBankCommand):
    now = datetime.now(timezone.utc)
    if body.action == "select":
        connection, stage = uuid4(), "consent"
    else:
        try:
            payload = json.loads(_cipher.decrypt((body.token or "").encode(), ttl=600))
            if payload["institution"] != body.institution or payload["stage"] != ("connected" if body.action == "import" else "consent"):
                raise ValueError()
            connection = UUID(payload["connection"])
        except (InvalidToken, ValueError, KeyError, TypeError):
            raise HTTPException(409, "Simulation expired. Choose a demo bank again.") from None
        stage = "connected" if body.action == "approve" else "cancelled" if body.action == "cancel" else "imported"
    session = BankSession(_scope, connection, 1, (), _as_of + timedelta(hours=1))
    bank = adapter(body.institution, session)
    authorization = bank.begin_consent(session)
    if body.action == "approve":
        bank.complete_consent(session, tuple(account.reference for account in authorization.available_accounts))
    result = {"mode": "simulated", "state": stage, "name": bank.capabilities().name,
              "notice": "Synthetic simulation only. Nothing is saved to your private accounts."}
    if stage in ("consent", "connected"):
        result["token"] = _cipher.encrypt(json.dumps({"institution": body.institution, "stage": stage,
            "connection": str(connection), "issued": now.isoformat()}).encode()).decode()
    if body.action == "import":
        session = replace(session, account_references=tuple(a.reference for a in authorization.available_accounts))
        bank = adapter(body.institution, session)
        rows, cursor = [], None
        while True:
            page = bank.fetch_transactions(session, session.account_references[0], as_of=_as_of,
                start=date(2026, 8, 1), end_exclusive=date(2026, 11, 5), cursor=cursor, limit=100)
            rows.extend(row.model_dump(mode="json") for row in page.rows if row.status == "booked")
            cursor = page.next_cursor
            if cursor is None:
                break
        result.update(transactions=rows, booked_transactions=len(rows), as_of=_as_of.isoformat())
    return result
