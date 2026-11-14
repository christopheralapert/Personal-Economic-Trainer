"""Owned ledger reads and reconciled observed spending; no model-generated SQL."""
from datetime import date
from typing import Literal
from uuid import UUID

from pydantic import Field
from psycopg.rows import dict_row

from .contracts import Contract, Currency, Minor, NonnegativeMinor
from .identity import AuthError
from .bank_access import bank_account_access
from .bank_sources import AccountSourceV1, history_coverage, source_evidence
from .scoped_keys import DataScope

CONSUMPTION = "((economic_flow='expense' AND amount_minor<=0) OR (economic_flow='refund' AND amount_minor>=0))"
GROSS = "CASE WHEN economic_flow='expense' AND amount_minor<=0 THEN -amount_minor ELSE 0 END"
REFUND = "CASE WHEN economic_flow='refund' AND amount_minor>=0 THEN amount_minor ELSE 0 END"
MINOR_LIMIT = 2**53-1
NEEDS_REVIEW = "(economic_flow='unknown' OR (economic_flow IN ('expense','refund') AND (category='unclassified' OR basket='unresolved')))"


class LedgerFilterV1(Contract):
    start: date
    end_exclusive: date
    currency: Currency = "EUR"
    account_ids: list[UUID] | None = Field(default=None,max_length=50)
    category: str | None = Field(default=None,max_length=100)
    merchant: str | None = Field(default=None,max_length=200)
    status: Literal["booked","pending","reversed"] = "booked"
    spending_only: bool = False
    needs_review: bool = False


class LedgerRowV1(Contract):
    id: UUID
    account_id: UUID
    amount_minor: Minor
    currency: Currency
    booked_on: date
    status: str
    merchant: str
    category: str
    basket: str
    economic_flow: str


class LedgerScopeV1(Contract):
    data_mode: Literal["synthetic","sandbox","live"] = "synthetic"
    account_ids: list[UUID]
    currency: Currency
    start: date
    end_exclusive: date
    permission_version: int
    data_version: int
    plan_version: int
    dataset_coverage: str = "unverified"
    scope_kind: Literal["included_accounts","selected_accounts"] = "included_accounts"
    whole_finances_confirmed: Literal[False] = False
    sources: list[AccountSourceV1] = Field(default_factory=list)
    unverified_account_ids: list[UUID] = Field(default_factory=list)


class LedgerPageV1(Contract):
    scope: LedgerScopeV1
    rows: list[LedgerRowV1]
    next_cursor: str | None


class LedgerInventoryV1(Contract):
    scope: LedgerScopeV1
    total_booked_count: int
    period_booked_count: int
    period_unresolved_count: int
    period_unresolved_gross_minor: NonnegativeMinor
    # Display-only outgoing cash awaiting purpose review. Never included in
    # confirmed expense totals, scenarios or safe-to-spend/save calculations.
    period_unreviewed_outgoing_minor: NonnegativeMinor = 0
    period_unreviewed_outgoing_count: int = 0
    available_start: date | None
    available_end_exclusive: date | None


class SpendingGroupV1(Contract):
    label: str
    basket: str | None = None
    gross_minor: NonnegativeMinor
    refunds_minor: NonnegativeMinor
    net_minor: Minor
    transaction_count: int


class SpendingTotalsV1(Contract):
    scope: LedgerScopeV1
    gross_minor: NonnegativeMinor
    refunds_minor: NonnegativeMinor
    net_minor: Minor
    expense_count: int
    refund_count: int
    unresolved_flow_count: int
    nonconsumption_count: int
    category_baskets: list[SpendingGroupV1]
    merchants: list[SpendingGroupV1]
    category_breakdown_truncated: bool
    merchant_breakdown_truncated: bool
    evidence_filters: LedgerFilterV1
    evidence_transaction_ids: list[UUID]
    limitations: list[str]


def bounded_money(value):
    result = int(value or 0)
    if not -MINOR_LIMIT<=result<=MINOR_LIMIT:
        raise AuthError("AMOUNT_RANGE_EXCEEDED",409)
    return result


class Ledger:
    def __init__(self,connection,user,filters,*,expected_data_version=None,now=None,maximum_age_hours=24):
        if filters.start>=filters.end_exclusive or (filters.end_exclusive-filters.start).days>3660:
            raise AuthError("INVALID_PERIOD",422)
        self.connection,self.user,self.filters = connection,user,filters
        owner = (user.scope.tenant_id,user.scope.user_id)
        state = connection.execute("SELECT data_version,plan_version FROM moneylens.user_state WHERE tenant_id=%s AND owner_user_id=%s",owner).fetchone()
        if state is None:
            raise AuthError("DATASET_STATE_UNAVAILABLE",409)
        if expected_data_version is not None and expected_data_version!=state[0]:
            raise AuthError("DATA_VERSION_CHANGED",409)
        if filters.account_ids is not None:
            if not filters.account_ids or len(set(filters.account_ids))!=len(filters.account_ids):
                raise AuthError("INVALID_ACCOUNT_SCOPE",422)
            accounts = connection.execute("""SELECT id,currency FROM moneylens.accounts WHERE tenant_id=%s AND owner_user_id=%s
                AND id=ANY(%s) AND included ORDER BY id""",(*owner,filters.account_ids)).fetchall()
            if len(accounts)!=len(filters.account_ids):
                raise AuthError("NOT_FOUND",404)
            if any(currency!=filters.currency for _,currency in accounts):
                raise AuthError("MIXED_CURRENCY_SCOPE",422)
        else:
            accounts = connection.execute("""SELECT id,currency FROM moneylens.accounts WHERE tenant_id=%s AND owner_user_id=%s
                AND included AND currency=%s ORDER BY id LIMIT 201""",(*owner,filters.currency)).fetchall()
            if len(accounts)>200:
                raise AuthError("NARROW_ACCOUNT_SCOPE",422)
        bank_account_access(connection,user,[row[0] for row in accounts],now=now)
        self.has_native=bool(accounts and connection.execute("""SELECT 1 FROM moneylens.accounts WHERE tenant_id=%s AND owner_user_id=%s
            AND id=ANY(%s) AND native_feed_id IS NOT NULL LIMIT 1""",(*owner,[row[0] for row in accounts])).fetchone())
        self.sources=source_evidence(connection,user,[row[0] for row in accounts],now=now,maximum_age_hours=maximum_age_hours)
        self.scope = DataScope(user.scope,user.permission_version,state[0],state[1],tuple(row[0] for row in accounts),filters.currency,
            filters.model_dump(mode="json",exclude={"account_ids","currency"}))

    def evidence_scope(self):
        return LedgerScopeV1(data_mode="synthetic" if self.user.synthetic else "sandbox" if self.sources and all(source.mode=="sandbox" for source in self.sources.values()) else "live",account_ids=list(self.scope.account_ids),currency=self.scope.currency,start=self.filters.start,
            end_exclusive=self.filters.end_exclusive,permission_version=self.scope.permission_version,
            data_version=self.scope.data_version,plan_version=self.scope.plan_version,
            scope_kind="selected_accounts" if self.filters.account_ids is not None else "included_accounts",
            dataset_coverage=history_coverage(self.scope.account_ids,self.sources,start=self.filters.start,end_exclusive=self.filters.end_exclusive),
            sources=[self.sources[identifier] for identifier in self.scope.account_ids if identifier in self.sources],
            unverified_account_ids=[identifier for identifier in self.scope.account_ids if identifier not in self.sources])

    def where(self,*,consumption=None):
        f = self.filters
        clauses = ["tenant_id=%s","owner_user_id=%s","account_id=ANY(%s)","currency=%s","booked_on>=%s","booked_on<%s","status=%s"]
        params = [self.user.scope.tenant_id,self.user.scope.user_id,list(self.scope.account_ids),f.currency,f.start,f.end_exclusive,f.status]
        if f.category is not None:
            clauses.append("category=%s")
            params.append(f.category)
        if f.needs_review:
            clauses.append(NEEDS_REVIEW)
        if f.merchant is not None:
            clauses.append("merchant ILIKE %s ESCAPE '!'")
            params.append("%"+f.merchant.replace("!","!!").replace("%","!%").replace("_","!_")+"%")
        if (f.spending_only if consumption is None else consumption):
            clauses.append(CONSUMPTION)
        return " AND ".join(clauses),params

    def page(self,codec,*,cursor=None,limit=50):
        if type(limit) is not int or not 1<=limit<=200:
            raise AuthError("INVALID_PAGE_SIZE",422)
        where,params = self.where()
        if cursor:
            position = codec.decode(cursor,self.scope)
            try:
                if set(position)!={"booked_on","id"}:
                    raise ValueError()
                last_date,last_id = date.fromisoformat(position["booked_on"]),UUID(position["id"])
            except (ValueError,TypeError,KeyError,AttributeError):
                raise AuthError("INVALID_CURSOR",400) from None
            where += " AND (booked_on,id)<(%s,%s)"
            params.extend([last_date,last_id])
        with self.connection.cursor(row_factory=dict_row) as query:
            rows = query.execute("SELECT id,account_id,amount_minor,currency,booked_on,status,merchant,category,basket,economic_flow FROM moneylens.analysis_transactions WHERE "+where+
                " ORDER BY booked_on DESC,id DESC LIMIT %s",[*params,limit+1]).fetchall()
        visible = [LedgerRowV1.model_validate(row) for row in rows[:limit]]
        next_cursor = codec.encode(self.scope,{"booked_on":visible[-1].booked_on.isoformat(),"id":str(visible[-1].id)}) if len(rows)>limit else None
        return LedgerPageV1(scope=self.evidence_scope(),rows=visible,next_cursor=next_cursor)

    def inventory(self):
        """Owned metadata across retained booked history; no flow is silently excluded."""
        from datetime import timedelta
        if self.filters.category or self.filters.merchant or self.filters.spending_only or self.filters.status!="booked":
            raise AuthError("INVALID_INVENTORY_SCOPE",422)
        row=self.connection.execute(f"""SELECT count(*),min(booked_on),max(booked_on),
            count(*) FILTER (WHERE booked_on>=%s AND booked_on<%s),
            count(*) FILTER (WHERE booked_on>=%s AND booked_on<%s AND {NEEDS_REVIEW}),
            coalesce(sum(CASE WHEN booked_on>=%s AND booked_on<%s
                AND economic_flow='expense' AND amount_minor<=0
                AND (economic_flow='unknown' OR basket='unresolved') THEN -amount_minor ELSE 0 END),0),
            coalesce(sum(CASE WHEN booked_on>=%s AND booked_on<%s AND economic_flow='unknown'
                AND amount_minor<0 THEN -amount_minor ELSE 0 END),0),
            count(*) FILTER (WHERE booked_on>=%s AND booked_on<%s AND economic_flow='unknown' AND amount_minor<0)
            FROM moneylens.analysis_transactions WHERE tenant_id=%s AND owner_user_id=%s
            AND account_id=ANY(%s) AND currency=%s AND status='booked'""",
            (self.filters.start,self.filters.end_exclusive,self.filters.start,self.filters.end_exclusive,
             self.filters.start,self.filters.end_exclusive,
             self.filters.start,self.filters.end_exclusive,self.filters.start,self.filters.end_exclusive,
             self.user.scope.tenant_id,self.user.scope.user_id,list(self.scope.account_ids),self.filters.currency)).fetchone()
        return LedgerInventoryV1(scope=self.evidence_scope(),total_booked_count=row[0],period_booked_count=row[3],
            period_unresolved_count=row[4],period_unresolved_gross_minor=bounded_money(row[5]),
            period_unreviewed_outgoing_minor=bounded_money(row[6]),period_unreviewed_outgoing_count=row[7],
            available_start=row[1],available_end_exclusive=row[2]+timedelta(days=1) if row[2] else None)

    def totals(self):
        if self.filters.status!="booked":
            raise AuthError("HISTORICAL_SPENDING_REQUIRES_BOOKED",422)
        where,params = self.where(consumption=False)
        aggregate = self.connection.execute(f"""SELECT coalesce(sum({GROSS}),0),coalesce(sum({REFUND}),0),
            count(*) FILTER (WHERE economic_flow='expense' AND amount_minor<=0),
            count(*) FILTER (WHERE economic_flow='refund' AND amount_minor>=0),
            count(*) FILTER (WHERE economic_flow='unknown' OR (economic_flow='expense' AND amount_minor>0) OR (economic_flow='refund' AND amount_minor<0)),
            count(*) FILTER (WHERE economic_flow IN ('income','internal_transfer','liability_settlement'))
            FROM moneylens.analysis_transactions WHERE {where}""",params).fetchone()
        gross,refund = (bounded_money(value) for value in aggregate[:2])
        categories,merchants = [],[]
        for column,target,cap in (("category,basket",categories,100),("merchant",merchants,20)):
            # Grouping columns and limits are fixed repository constants, never model SQL.
            rows = self.connection.execute(f"""SELECT {column},sum({GROSS}),sum({REFUND}),count(*)
                FROM moneylens.analysis_transactions WHERE {where} AND {CONSUMPTION}
                GROUP BY {column} ORDER BY sum({GROSS})-sum({REFUND}) DESC,{column} LIMIT %s""",[*params,cap+1]).fetchall()
            for row in rows:
                offset = 2 if column=="category,basket" else 1
                item_gross,item_refund = bounded_money(row[offset]),bounded_money(row[offset+1])
                target.append(SpendingGroupV1(label=row[0],basket=row[1] if offset==2 else None,
                    gross_minor=item_gross,refunds_minor=item_refund,net_minor=bounded_money(item_gross-item_refund),transaction_count=row[offset+2]))
        evidence = self.connection.execute(f"SELECT id FROM moneylens.analysis_transactions WHERE {where} AND {CONSUMPTION} ORDER BY booked_on DESC,id DESC LIMIT 5",params).fetchall()
        evidence_filters = self.filters.model_copy(update={"spending_only":True,"account_ids":list(self.scope.account_ids) or None})
        return SpendingTotalsV1(scope=self.evidence_scope(),gross_minor=gross,refunds_minor=refund,net_minor=bounded_money(gross-refund),
            expense_count=aggregate[2],refund_count=aggregate[3],unresolved_flow_count=aggregate[4],nonconsumption_count=aggregate[5],
            category_baskets=categories[:100],merchants=merchants[:20],category_breakdown_truncated=len(categories)>100,
            merchant_breakdown_truncated=len(merchants)>20,evidence_filters=evidence_filters,evidence_transaction_ids=[row[0] for row in evidence],
            limitations=["Observed booked records only. Source coverage applies to the named accounts and observations; whole-finance and household coverage are not established.",
                "Zero observed records do not establish zero spending when source coverage is partial or unverified.",
                "Refunds reduce spending in their booking period. Income, transfers and liability settlements are excluded.",
                "Currencies are queried separately. No exchange-rate conversion or current-balance inference is performed."]+(
                    ["Native import totals include source-labelled expenses only; other imported flows remain unresolved pending relationship review."] if self.has_native else []))
