"""Closed synthetic institutions: deterministic data, injected clock and faults.

Never calls a network service. A supplied durable-authority guard is mandatory
for every account-data operation. Simulator controls are not live bank behavior.
"""
from datetime import date, datetime, timedelta, timezone
import hashlib
import json
from pathlib import Path
from typing import Literal
from uuid import UUID, uuid5
from zoneinfo import ZoneInfo

from cryptography.fernet import Fernet, InvalidToken

from .bank_adapter import (BankAccountV1, BankAuthorizationV1, BankBalanceV1, BankCapabilitiesV1,
    BankError, BankGrantV1, BankGuard, BankId, BankRevocationV1, BankSession, BankTransactionPageV1, BankTransactionV1)
from .synthetic_registry import SYNTHETIC_INSTITUTIONS
from .identity import derive
from .planning_policy import utc

ROOT = Path(__file__).resolve().parents[3]
NAMESPACE = UUID("78ee9772-4c69-4568-9317-d3b243b75b2f")
Fault = Literal["healthy", "unavailable", "throttled", "expired", "stale", "partial", "pending", "booked"]
FAULTS = {"healthy", "unavailable", "throttled", "expired", "stale", "partial", "pending", "booked"}


def provider_reference(scope,institution):
    return str(uuid5(NAMESPACE,f"{scope.tenant_id}:{scope.user_id}:{institution}:main"))


class SyntheticBank:
    def __init__(self,institution: BankId,guard: BankGuard,secret: str,*,clock=lambda:datetime.now(timezone.utc),fault: Fault="healthy"):
        if institution not in SYNTHETIC_INSTITUTIONS or fault not in FAULTS or not callable(guard):
            raise ValueError("Use a registered synthetic institution, guard and fault")
        self.institution,self.guard,self.clock,self.fault = institution,guard,clock,fault
        self.cipher = Fernet((derive(secret,"bank.cursor.v1","")+"=").encode())
        self.profile_data = json.loads((ROOT / "fixtures/synthetic/demo.v1.json").read_text(encoding="utf-8"))["profiles"]

    def capabilities(self):
        first = SYNTHETIC_INSTITUTIONS[self.institution]["template"]=="s-bank-demo"
        return BankCapabilitiesV1(id=self.institution,name=SYNTHETIC_INSTITUTIONS[self.institution]["name"],country=SYNTHETIC_INSTITUTIONS[self.institution]["country"],
            notice="Entirely synthetic simulator. No connection to S-Bank, PSD2 sandbox or live customer accounts.",
            currencies=["EUR"],account_types=["current"],balance_kind="available" if first else "booked",
            pending_reflection="included" if first else "excluded",supports_pending=True,maximum_page_size=100,
            history_from=date(2026,8,1),minimum_refresh_seconds=30,consent_seconds=3600 if first else 1800,timeout_seconds=5)

    def account(self,session):
        ref = provider_reference(session.scope,self.institution)
        return BankAccountV1(reference=ref,canonical_reference="synthetic:"+ref,name=self.capabilities().name,currency="EUR",account_type="current")

    def check(self,session,purpose,account=None):
        self.guard(session,purpose)
        if purpose=="read":
            if session.expires_at is None or utc(session.expires_at)<=utc(self.clock()) or self.fault=="expired":
                raise BankError("consent_expired")
            expected = self.account(session).reference
            if account is not None and (account!=expected or account not in session.account_references):
                raise BankError("account_not_granted")
            if self.fault=="unavailable":
                raise BankError("bank_unavailable",retryable=True)
            if self.fault=="throttled":
                raise BankError("bank_throttled",retryable=True,retry_after_seconds=30)

    def begin_consent(self,session):
        self.check(session,"authorize")
        return BankAuthorizationV1(reference=str(session.connection_id),available_accounts=[self.account(session)],
            expires_at=utc(self.clock())+timedelta(minutes=10),notice=self.capabilities().notice)

    def complete_consent(self,session,selected):
        self.check(session,"authorize")
        if selected!=(self.account(session).reference,):
            raise BankError("invalid_account_selection")
        return BankGrantV1(reference=str(session.connection_id),account_references=list(selected),
            expires_at=utc(self.clock())+timedelta(seconds=self.capabilities().consent_seconds))

    def list_accounts(self,session):
        self.check(session,"discover")
        return [self.account(session)]

    def snapshot(self,as_of):
        instant = utc(as_of)
        now = utc(self.clock())
        if not timedelta(0)<=now-instant<=timedelta(minutes=5):
            raise BankError("invalid_snapshot_time")
        if self.fault=="stale":
            instant -= timedelta(days=2)
        material = f"sim.v1:{self.institution}:{self.fault}:{instant.isoformat()}"
        return instant,"sim.v1."+hashlib.sha256(material.encode()).hexdigest()[:24]

    def fetch_balances(self,session,account_reference,*,as_of):
        self.check(session,"read",account_reference)
        instant,version = self.snapshot(as_of)
        amount = 50000 if SYNTHETIC_INSTITUTIONS[self.institution]["template"]=="s-bank-demo" else 30000
        # Available includes a pending hold; booked basis excludes it. Settlement
        # changes the North booked balance once, while S-Bank own cash stays net.
        if self.fault=="booked":
            amount -= 4600
        elif self.fault=="pending" and SYNTHETIC_INSTITUTIONS[self.institution]["template"]=="s-bank-demo":
            amount -= 4200
        caps = self.capabilities()
        return [BankBalanceV1(reference=str(uuid5(session.connection_id,f"{account_reference}:{version}:balance")),
            account_reference=account_reference,amount_minor=amount,currency="EUR",kind=caps.balance_kind,
            pending_reflection=caps.pending_reflection,included_credit_minor=0,inaccessible_minor=0,
            observed_at=instant,source_version=version)]

    def dataset(self,session):
        # Known seeded profiles preserve exact authored transactions. Other test/
        # synthetic owners get the same small template with owner-specific refs.
        profile = next((item for item in self.profile_data if item["accounts"][0]["owner"]=={
            "tenant_id":str(session.scope.tenant_id),"user_id":str(session.scope.user_id)}),self.profile_data[0])
        account = next(item for item in profile["accounts"] if item["institution_id"]==SYNTHETIC_INSTITUTIONS[self.institution]["template"])
        local = {item["id"]:item for item in profile["transactions"]}
        account_bank = {item["id"]:item["institution_id"] for item in profile["accounts"]}
        ref = self.account(session).reference
        return [BankTransactionV1(reference=tx["provider_id"],account_reference=ref,revision=1,amount_minor=tx["amount_minor"],
            currency=tx["currency"],booked_on=tx["booked_on"],status=tx["status"],merchant=tx["merchant"],category=tx["category"],
            basket=tx["basket"],economic_flow=tx["economic_flow"],
            related_reference=local[tx["related_transaction_id"]]["provider_id"] if tx["related_transaction_id"] else None,
            related_institution=account_bank[local[tx["related_transaction_id"]]["account_id"]] if tx["related_transaction_id"] else None)
            for tx in profile["transactions"] if tx["account_id"]==account["id"]]

    def fetch_transactions(self,session,account_reference,*,as_of,start,end_exclusive,cursor=None,limit=100):
        self.check(session,"read",account_reference)
        if type(limit) is not int or not 1<=limit<=self.capabilities().maximum_page_size:
            raise BankError("invalid_page_size")
        instant,version = self.snapshot(as_of)
        if type(start) is not date or type(end_exclusive) is not date or not start<end_exclusive or (end_exclusive-start).days>733:
            raise BankError("invalid_history_window")
        source_day = instant.astimezone(ZoneInfo(self.capabilities().timezone)).date()
        through = min(end_exclusive,source_day+timedelta(days=1))
        earliest = max(start,self.capabilities().history_from)
        binding = {"tenant":str(session.scope.tenant_id),"user":str(session.scope.user_id),"connection":str(session.connection_id),
            "generation":session.generation,"accounts":sorted(session.account_references),"institution":self.institution,
            "account":account_reference,"source_version":version,"start":start.isoformat(),"end":end_exclusive.isoformat(),"limit":limit}
        expected = hashlib.sha256(json.dumps(binding,sort_keys=True).encode()).hexdigest()
        offset = 0
        if cursor:
            try:
                if not isinstance(cursor,str) or len(cursor)>4096:
                    raise ValueError()
                payload = json.loads(self.cipher.decrypt(cursor.encode()))
                if set(payload)!={"binding","offset","expires"} or payload["binding"]!=expected or type(payload["offset"]) is not int or not 0<=payload["offset"]<=10000:
                    raise ValueError()
                if type(payload["expires"]) is not int or payload["expires"]<=int(utc(self.clock()).timestamp()):
                    raise ValueError()
                offset = payload["offset"]
            except (InvalidToken,ValueError,TypeError,UnicodeError):
                raise BankError("invalid_source_cursor") from None
        rows = self.dataset(session)
        if self.fault in ("pending","booked"):
            rows.append(BankTransactionV1(reference="sim-pending-transition",account_reference=account_reference,revision=1 if self.fault=="pending" else 2,
                amount_minor=-4200 if self.fault=="pending" else -4600,currency="EUR",booked_on=source_day,status="pending" if self.fault=="pending" else "booked",
                merchant="Synthetic pending purchase",category="groceries",basket="unresolved",economic_flow="expense"))
        visible = sorted((row for row in rows if earliest<=row.booked_on<through),key=lambda row:(row.booked_on,row.reference))
        if self.fault=="partial":
            visible = visible[:2]
        page = visible[offset:offset+limit]
        continuation = self.cipher.encrypt(json.dumps({"binding":expected,"offset":offset+limit,
            "expires":int(utc(self.clock()).timestamp())+300},sort_keys=True).encode()).decode() if offset+limit<len(visible) else None
        return BankTransactionPageV1(rows=page,next_cursor=continuation,source_version=version,observed_at=instant,
            coverage_from=earliest,coverage_to_exclusive=max(earliest,through),
            complete=self.fault!="partial" and earliest==start and through==end_exclusive)

    def revoke_consent(self,session):
        self.check(session,"revoke")
        # Local provider acknowledgement only. The service must atomically retain
        # revoked state/generation in its durable connection authority.
        return BankRevocationV1()
