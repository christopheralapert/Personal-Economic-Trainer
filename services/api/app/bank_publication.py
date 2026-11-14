"""Atomic canonical publication for the two closed synthetic providers only."""
from datetime import date, datetime, timedelta, timezone
from uuid import UUID, uuid5
from zoneinfo import ZoneInfo

from .bank_adapter import BankAccountV1, BankBalanceV1, BankError, BankTransactionV1
from .bank_store import BankStore
from .bank_staging import verify_stage
from .bank_reconciliation import check_revision
from .planning_policy import utc
from .synthetic_banks import NAMESPACE, provider_reference
from .transfer_detection import internal_transfer_ids


class BankPublication:
    def __init__(self,connection,user,secret,*,clock=lambda:datetime.now(timezone.utc)):
        self.connection,self.user,self.clock=connection,user,clock
        self.banks=BankStore(connection,user,secret,clock=clock)
        self.owner=self.banks.owner

    def profile(self,adapter):
        return next((profile for profile in adapter.profile_data if profile["accounts"][0]["owner"]=={
            "tenant_id":str(self.owner[0]),"user_id":str(self.owner[1])}),None)

    def account_id(self,institution,profile):
        if profile:
            return UUID(next(account["id"] for account in profile["accounts"] if account["institution_id"]==institution))
        return uuid5(NAMESPACE,f"{self.owner[0]}:{self.owner[1]}:{institution}:canonical")

    def transaction_id(self,institution,reference,profile):
        account_id=self.account_id(institution,profile)
        if profile:
            known=next((row for row in profile["transactions"] if row["provider_id"]==reference and row["account_id"]==str(account_id)),None)
            if known:
                return UUID(known["id"])
        return uuid5(account_id,"bank.transaction:"+reference)

    def publish(self,identifier,*,fetch_job_id,generation):
        with self.banks.transaction(write=True):
            return self.effect(identifier,fetch_job_id=fetch_job_id,generation=generation)

    def effect(self,identifier,*,fetch_job_id,generation):
        """Caller owns the exclusive membership fence and any publication job lease."""
        row=self.banks.row(identifier)
        session=self.banks.session(row)
        self.banks.guard(session,"read")
        if generation!=session.generation:
            raise BankError("consent_scope_changed")
        published=self.banks.one("""SELECT id FROM moneylens.bank_refresh_requests WHERE tenant_id=%s AND owner_user_id=%s
            AND connection_id=%s AND job_id=%s AND published_at IS NOT NULL LIMIT 1""",(*self.owner,identifier,fetch_job_id))
        if published:
            return False
        checkpoint=row["sync_checkpoint"]
        job=self.banks.one("SELECT state,permission_version,type FROM moneylens.jobs WHERE tenant_id=%s AND owner_user_id=%s AND id=%s",(*self.owner,fetch_job_id))
        if not job or job["state"]!="completed" or job["type"]!="bank.fetch" or job["permission_version"]!=self.user.permission_version:
            raise BankError("source_job_not_current")
        if row["refresh_job_id"]!=fetch_job_id or row["sync_health"] not in ("staged","error") or not checkpoint or (
            checkpoint.get("phase"),checkpoint.get("job_id"),checkpoint.get("generation"))!=("ready",str(fetch_job_id),generation):
            raise BankError("source_stage_not_current")
        adapter=self.banks.adapter(row)
        verify_stage(self.banks.secret,self.user.scope,identifier,checkpoint)
        account=BankAccountV1.model_validate(checkpoint["account"])
        balances=[BankBalanceV1.model_validate(item) for item in checkpoint["balances"]]
        transactions=[BankTransactionV1.model_validate(item) for item in checkpoint["rows"]]
        expected=provider_reference(self.user.scope,row["provider"])
        caps=adapter.capabilities()
        now=utc(self.clock())
        observed=utc(datetime.fromisoformat(checkpoint["source_observed_at"]))
        if account.reference!=expected or account.canonical_reference!="synthetic:"+expected or session.account_references!=(expected,):
            raise BankError("source_account_mismatch")
        if account.currency not in caps.currencies or account.account_type not in caps.account_types:
            raise BankError("source_account_mismatch")
        if len(balances)!=1 or not timedelta(0)<=now-observed<=timedelta(hours=24):
            raise BankError("source_stale")
        balance=balances[0]
        if (balance.account_reference,balance.currency,balance.kind,balance.pending_reflection,balance.source_version,utc(balance.observed_at))!=(
            expected,account.currency,caps.balance_kind,caps.pending_reflection,checkpoint["source_version"],observed):
            raise BankError("incoherent_source_snapshot")
        start,end=date.fromisoformat(checkpoint["coverage_from"]),date.fromisoformat(checkpoint["coverage_to_exclusive"])
        if start!=caps.history_from or end!=observed.astimezone(ZoneInfo(caps.timezone)).date()+timedelta(days=1):
            raise BankError("source_incomplete")
        if len(transactions)>2000 or len({item.reference for item in transactions})!=len(transactions) or any(
            item.account_reference!=expected or item.currency!=account.currency or not start<=item.booked_on<end for item in transactions):
            raise BankError("invalid_source_transactions")
        profile=self.profile(adapter)
        account_id=self.account_id(row["provider"],profile)
        existing=self.banks.one("SELECT currency,account_type FROM moneylens.accounts WHERE tenant_id=%s AND owner_user_id=%s AND id=%s",(*self.owner,account_id))
        if existing and (existing["currency"],existing["account_type"])!=(account.currency,account.account_type):
            raise BankError("canonical_account_conflict")
        self.connection.execute("""INSERT INTO moneylens.accounts (tenant_id,owner_user_id,id,name,currency,account_type)
            VALUES (%s,%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING""",(*self.owner,account_id,account.name,account.currency,account.account_type))
        alias_id=uuid5(identifier,account.reference)
        alias=self.banks.one("SELECT account_id FROM moneylens.account_source_aliases WHERE tenant_id=%s AND owner_user_id=%s AND connection_id=%s AND provider_account_id=%s",
            (*self.owner,identifier,account.reference))
        if alias and alias["account_id"]!=account_id:
            raise BankError("canonical_account_conflict")
        latest=self.connection.execute("""SELECT max(observed_at) FROM moneylens.account_source_aliases
            WHERE tenant_id=%s AND owner_user_id=%s AND account_id=%s""",(*self.owner,account_id)).fetchone()[0]
        if latest and observed<utc(latest):
            raise BankError("source_observation_regressed")
        self.connection.execute("""INSERT INTO moneylens.account_source_aliases
            (tenant_id,owner_user_id,id,account_id,connection_id,provider_account_id,canonical_reference,source_version,observed_at,coverage_from,coverage_to_exclusive)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) ON CONFLICT (tenant_id,owner_user_id,connection_id,provider_account_id)
            DO UPDATE SET source_version=excluded.source_version,observed_at=excluded.observed_at,
                coverage_from=excluded.coverage_from,coverage_to_exclusive=excluded.coverage_to_exclusive""",
            (*self.owner,alias_id,account_id,identifier,account.reference,account.canonical_reference,checkpoint["source_version"],observed,start,end))
        incoming={self.transaction_id(row["provider"],item.reference,profile):item for item in transactions}
        previous=self.connection.execute("""SELECT id FROM moneylens.transactions WHERE tenant_id=%s AND owner_user_id=%s AND account_id=%s
            AND connection_id IS NOT NULL AND booked_on>=%s AND booked_on<%s LIMIT 2001""",(*self.owner,account_id,start,end)).fetchall()
        if len(previous)>2000 or any(item[0] not in incoming for item in previous):
            raise BankError("source_history_changed")
        for tx_id,item in incoming.items():
            prior=self.banks.one("SELECT * FROM moneylens.transactions WHERE tenant_id=%s AND owner_user_id=%s AND id=%s",(*self.owner,tx_id))
            if prior:
                if prior["account_id"]!=account_id or prior["source_id"]!=item.reference:
                    raise BankError("source_identity_conflict")
            digest=check_revision(prior,item,observed)
            flow="unknown" if item.economic_flow=="internal_transfer" else item.economic_flow
            self.connection.execute("""INSERT INTO moneylens.transactions
                (tenant_id,owner_user_id,id,account_id,connection_id,source_id,source_revision,amount_minor,currency,booked_on,status,
                    merchant,category,basket,economic_flow,observed_at,provider_related_reference,provider_related_institution,source_economic_flow,source_payload_hash)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                ON CONFLICT (tenant_id,owner_user_id,id) DO UPDATE SET connection_id=excluded.connection_id,
                    source_revision=excluded.source_revision,amount_minor=excluded.amount_minor,currency=excluded.currency,
                    booked_on=excluded.booked_on,status=excluded.status,merchant=excluded.merchant,
                    category=CASE WHEN moneylens.transactions.source_revision<excluded.source_revision THEN excluded.category ELSE moneylens.transactions.category END,
                    basket=CASE WHEN moneylens.transactions.source_revision<excluded.source_revision THEN excluded.basket ELSE moneylens.transactions.basket END,
                    economic_flow=excluded.economic_flow,observed_at=CASE WHEN moneylens.transactions.source_revision<excluded.source_revision
                        THEN excluded.observed_at ELSE moneylens.transactions.observed_at END,
                    provider_related_reference=excluded.provider_related_reference,provider_related_institution=excluded.provider_related_institution,
                    source_economic_flow=excluded.source_economic_flow,source_payload_hash=excluded.source_payload_hash""",
                (*self.owner,tx_id,account_id,identifier,item.reference,item.revision,item.amount_minor,item.currency,item.booked_on,item.status,
                    item.merchant,item.category,item.basket,flow,observed,item.related_reference,item.related_institution,item.economic_flow,digest))
        self.relations(incoming,row["provider"],profile)
        self.mark_inferred_transfers()
        balance_id=uuid5(account_id,f"bank.balance:{identifier}:{balance.reference}")
        self.connection.execute("""INSERT INTO moneylens.balance_snapshots
            (tenant_id,owner_user_id,id,account_id,amount_minor,currency,balance_kind,pending_reflection,included_credit_minor,observed_at,connection_id,source_version)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING""",
            (*self.owner,balance_id,account_id,balance.amount_minor,balance.currency,balance.kind,balance.pending_reflection,
                balance.included_credit_minor,observed,identifier,balance.source_version))
        self.banks.guard(session,"read")
        self.connection.execute("""UPDATE moneylens.connections SET sync_health='fresh',last_success_at=%s,last_error_code=NULL,
            published_job_id=%s,published_source_version=%s,sync_checkpoint=NULL WHERE tenant_id=%s AND owner_user_id=%s AND id=%s""",
            (now,fetch_job_id,checkpoint["source_version"],*self.owner,identifier))
        self.connection.execute("""UPDATE moneylens.bank_refresh_requests SET published_at=%s WHERE tenant_id=%s AND owner_user_id=%s
            AND connection_id=%s AND job_id=%s AND published_at IS NULL""",(now,*self.owner,identifier,fetch_job_id))
        self.banks.record("bank.published",identifier,invalidate=True)
        return True

    def relations(self,incoming,institution,profile):
        for identifier,item in incoming.items():
            if not item.related_reference or not item.related_institution:
                continue
            target=self.transaction_id(item.related_institution,item.related_reference,profile)
            other=self.banks.one("SELECT * FROM moneylens.transactions WHERE tenant_id=%s AND owner_user_id=%s AND id=%s",(*self.owner,target))
            if not other:
                continue
            if other["account_id"]!=self.account_id(item.related_institution,profile) or other["source_id"]!=item.related_reference:
                raise BankError("source_relationship_conflict")
            self.connection.execute("UPDATE moneylens.transactions SET related_transaction_id=%s WHERE tenant_id=%s AND owner_user_id=%s AND id=%s",
                (target,*self.owner,identifier))
            mutual=(other["provider_related_reference"]==item.reference and other["provider_related_institution"]==institution)
            if mutual:
                self.connection.execute("UPDATE moneylens.transactions SET related_transaction_id=%s WHERE tenant_id=%s AND owner_user_id=%s AND id=%s",
                    (identifier,*self.owner,target))
            if not (mutual and item.economic_flow==other["source_economic_flow"]=="internal_transfer" and other["account_id"]!=self.account_id(institution,profile)
                and item.currency==other["currency"] and item.amount_minor==-other["amount_minor"] and item.amount_minor!=0):
                continue
            if self.connection.execute("""SELECT 1 FROM moneylens.classification_corrections
                    WHERE tenant_id=%s AND owner_user_id=%s AND transaction_id=ANY(%s) LIMIT 1""",
                    (*self.owner,[identifier,target])).fetchone():
                continue
            debit,credit=(identifier,target) if item.amount_minor<0 else (target,identifier)
            self.connection.execute("UPDATE moneylens.transactions SET economic_flow='internal_transfer' WHERE tenant_id=%s AND owner_user_id=%s AND id=ANY(%s)",(*self.owner,[identifier,target]))
            self.connection.execute("""INSERT INTO moneylens.transfer_links (tenant_id,owner_user_id,id,debit_id,credit_id,reason,state)
                VALUES (%s,%s,%s,%s,%s,'synthetic_mutual_source_reference.v1','confirmed')
                ON CONFLICT (tenant_id,owner_user_id,debit_id,credit_id) DO NOTHING""",(*self.owner,uuid5(debit,str(credit)),debit,credit))

    def mark_inferred_transfers(self):
        rows=self.connection.execute("""SELECT t.id,t.account_id,t.amount_minor,t.currency,t.booked_on,
                t.merchant,a.name AS account_name
            FROM moneylens.transactions t JOIN moneylens.accounts a ON a.id=t.account_id
            WHERE t.tenant_id=%s AND t.owner_user_id=%s AND NOT EXISTS (
                SELECT 1 FROM moneylens.classification_corrections c WHERE c.tenant_id=t.tenant_id
                    AND c.owner_user_id=t.owner_user_id AND c.transaction_id=t.id)""",self.owner).fetchall()
        ids=internal_transfer_ids([dict(zip(
            ("id","account_id","amount_minor","currency","booked_on","merchant","account_name"), row
        )) for row in rows])
        if ids:
            self.connection.execute("UPDATE moneylens.transactions SET economic_flow='internal_transfer' WHERE tenant_id=%s AND owner_user_id=%s AND id=ANY(%s)",
                (*self.owner,list(ids)))
