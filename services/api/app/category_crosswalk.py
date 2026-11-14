"""Application-authored, snapshot-bound category mapping; no personal provider calls."""
from functools import lru_cache
import hashlib
import json
from pathlib import Path
from typing import Annotated,Literal
from uuid import UUID

from pydantic import Field,StrictInt,model_validator

from .contracts import Contract,Minor,NonnegativeMinor
from .ledger import LedgerFilterV1,LedgerScopeV1,SpendingTotalsV1,bounded_money
from .statfin import COICOP,SnapshotError,load_snapshot

ROOT=Path(__file__).resolve().parents[3]
CROSSWALK=ROOT/"fixtures/public/statfin/category-crosswalk.v1.json"
Category=Annotated[str,Field(max_length=100)]
Code=Annotated[str,Field(pattern=r"^[0-9]{2,5}$")]


class CrosswalkTargetV1(Contract):
    code: Code
    label: str = Field(min_length=1,max_length=200)


class CrosswalkRuleV1(Contract):
    category: Annotated[Category,Field(min_length=1)]
    definition: str = Field(min_length=1,max_length=500)
    status: Literal["mapped","ambiguous","excluded"]
    target_code: Code | None
    candidate_codes: list[Code] = Field(max_length=6)
    reason: str = Field(min_length=1,max_length=500)

    @model_validator(mode="after")
    def consistent_mapping(self):
        if len(set(self.candidate_codes))!=len(self.candidate_codes):
            raise ValueError("Duplicate candidate")
        if (self.status=="mapped") != (self.target_code is not None):
            raise ValueError("Only resolved mappings have a target")
        if (self.status=="ambiguous") != bool(self.candidate_codes):
            raise ValueError("Only ambiguous rules have candidates")
        return self


class CategoryCrosswalkPolicyV1(Contract):
    mapping_version: Literal["moneylens.coicop2018.v1"]
    category_taxonomy: Literal["moneylens.synthetic.categories.v1"]
    classification_version: Literal["COICOP2018"]
    snapshot_id: str
    table_id: Literal["14ph"]
    metadata_fingerprint: str = Field(pattern=r"^[a-f0-9]{64}$")
    source_url: str
    attribution: str
    licence: Literal["CC-BY-4.0"]
    targets: list[CrosswalkTargetV1] = Field(min_length=1,max_length=6)
    rules: list[CrosswalkRuleV1] = Field(min_length=1,max_length=50)
    limitations: list[str] = Field(max_length=20)


class CategoryCrosswalkViewV1(CategoryCrosswalkPolicyV1):
    policy_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")


class PublicCrosswalkContextV1(Contract):
    available: bool
    policy: CategoryCrosswalkViewV1 | None = None
    reason: str | None = None


class CategoryMappingV1(Contract):
    category: Category
    status: Literal["mapped","ambiguous","excluded","unmapped"]
    target_code: Code | None
    candidate_codes: list[Code]
    reason: str


class CrosswalkAmountV1(Contract):
    gross_minor: NonnegativeMinor = 0
    refunds_minor: NonnegativeMinor = 0
    net_minor: Minor = 0
    transaction_count: Annotated[StrictInt,Field(ge=0,le=2**53-1)] = 0

    @model_validator(mode="after")
    def reconciled(self):
        if self.gross_minor-self.refunds_minor!=self.net_minor:
            raise ValueError("Gross/refunds/net do not reconcile")
        return self


class CrosswalkAssignedV1(Contract):
    target: CrosswalkTargetV1
    assigned_observed: CrosswalkAmountV1


class CategoryMappingCoverageV1(Contract):
    status: Literal["resolved","partial","unavailable"]
    mapping_version: str
    policy_sha256: str
    category_taxonomy: str
    snapshot_id: str
    classification_version: Literal["COICOP2018"] = "COICOP2018"
    scope: LedgerScopeV1
    evidence_filters: LedgerFilterV1
    evidence_transaction_ids: list[UUID] = Field(max_length=5)
    total_observed: CrosswalkAmountV1
    mapped: CrosswalkAmountV1
    ambiguous: CrosswalkAmountV1
    excluded: CrosswalkAmountV1
    unmapped: CrosswalkAmountV1
    outside_selection: CrosswalkAmountV1
    assignments: list[CrosswalkAssignedV1] = Field(max_length=6)
    decisions: list[CategoryMappingV1] = Field(max_length=100)
    unresolved_flow_count: StrictInt
    nonconsumption_count: StrictInt
    population_comparison_ready: Literal[False] = False
    limitations: list[str]


class CategoryCrosswalk:
    def __init__(self,policy,manifest,documents):
        self._policy=CategoryCrosswalkPolicyV1.model_validate(policy).model_copy(deep=True)
        p=self._policy
        metadata=manifest["tables"]["14ph"]
        if (p.snapshot_id,p.metadata_fingerprint,p.source_url,p.attribution,p.licence,p.classification_version)!=(
            manifest["snapshot_id"],metadata["schema_fingerprint"],metadata["source_url"],manifest["attribution"],manifest["licence"],manifest["classification_version"]):
            raise SnapshotError("CROSSWALK_SOURCE_CHANGED")
        labels=documents["14ph.response.json"]["dimension"][COICOP]["category"]["label"]
        targets={target.code:target.label for target in p.targets}
        if len(targets)!=len(p.targets) or targets!=labels:
            raise SnapshotError("CROSSWALK_TARGETS_CHANGED")
        if len({rule.category for rule in p.rules})!=len(p.rules):
            raise SnapshotError("DUPLICATE_CROSSWALK_CATEGORY")
        if any((rule.target_code is not None and rule.target_code not in targets) or not set(rule.candidate_codes)<=targets.keys() for rule in p.rules):
            raise SnapshotError("CROSSWALK_TARGETS_CHANGED")
        self._rules={rule.category:rule for rule in p.rules}
        self._targets={target.code:target for target in p.targets}
        canonical=json.dumps(p.model_dump(mode="json"),sort_keys=True,separators=(",",":"),ensure_ascii=True).encode()
        self.digest=hashlib.sha256(canonical).hexdigest()

    def view(self):
        return CategoryCrosswalkViewV1(**self._policy.model_dump(),policy_sha256=self.digest)

    def resolve(self,category,*,taxonomy):
        if taxonomy!=self._policy.category_taxonomy:
            return CategoryMappingV1(category=category,status="unmapped",target_code=None,candidate_codes=[],reason="The source taxonomy has no reviewed crosswalk; matching label text is insufficient.")
        rule=self._rules.get(category)
        if rule is None:
            return CategoryMappingV1(category=category,status="unmapped",target_code=None,candidate_codes=[],reason="This category has no reviewed rule in the named taxonomy.")
        return CategoryMappingV1(**rule.model_dump(exclude={"definition"}))

    def selection(self,codes):
        if not 1<=len(codes)<=6 or len(set(codes))!=len(codes) or not set(codes)<=self._targets.keys():
            raise ValueError("INVALID_CROSSWALK_SELECTION")
        if any(first!=second and first.startswith(second) for first in codes for second in codes):
            raise ValueError("OVERLAPPING_CROSSWALK_SELECTION")
        return [self._targets[code].model_copy(deep=True) for code in codes]

    def apply(self,totals:SpendingTotalsV1,*,taxonomy,target_codes):
        """Pure internal mapping of authorized ledger totals, never an ownership API.

        All confirmed consumption is assigned to one visible bucket. Category
        baskets are intentionally ignored as a classification signal.
        """
        targets=self.selection(target_codes)
        zero=lambda: {"gross_minor":0,"refunds_minor":0,"net_minor":0,"transaction_count":0}
        amount=lambda group: {"gross_minor":group.gross_minor,"refunds_minor":group.refunds_minor,
            "net_minor":group.net_minor,"transaction_count":group.transaction_count}
        def add(destination,values):
            for key,value in values.items():
                destination[key]=bounded_money(destination[key]+value)
        total=CrosswalkAmountV1(gross_minor=totals.gross_minor,refunds_minor=totals.refunds_minor,net_minor=totals.net_minor,
            transaction_count=totals.expense_count+totals.refund_count)
        buckets={name:zero() for name in ("mapped","ambiguous","excluded","unmapped","outside_selection")}
        assigned={target.code:zero() for target in targets}
        decisions=[]
        limitations=list(self._policy.limitations)
        if totals.category_breakdown_truncated:
            buckets["unmapped"]=total.model_dump()
            status="unavailable"
            limitations.append("The category breakdown is truncated. No partial top-N mapping is published; all observed consumption remains unallocated/unmapped.")
        else:
            if len(totals.category_baskets)>100:
                raise ValueError("CROSSWALK_GROUP_LIMIT")
            reconciled=zero()
            for group in totals.category_baskets:
                CrosswalkAmountV1(**amount(group))
                add(reconciled,amount(group))
            if reconciled!=total.model_dump():
                raise ValueError("CROSSWALK_TOTALS_MISMATCH")
            for group in totals.category_baskets:
                decision=self.resolve(group.label,taxonomy=taxonomy)
                bucket=decision.status
                if decision.status=="mapped":
                    # Exact child-to-parent rollup is possible; parent-to-child
                    # distribution and ambiguous-candidate allocation are not.
                    target=next((target.code for target in targets if decision.target_code.startswith(target.code)),None)
                    if target is None:
                        children=[target.code for target in targets if target.code.startswith(decision.target_code)]
                        if children:
                            decision=CategoryMappingV1(category=group.label,status="ambiguous",target_code=None,candidate_codes=children,
                                reason="A known parent category cannot be distributed to selected child categories without additional classification.")
                            bucket="ambiguous"
                        else:
                            bucket="outside_selection"
                    else:
                        add(assigned[target],amount(group))
                add(buckets[bucket],amount(group))
                decisions.append(decision)
            status="partial" if taxonomy!=self._policy.category_taxonomy or any(item.status in ("ambiguous","unmapped") for item in decisions) else "resolved"
        limitations.extend([
            "Assigned observed amounts are not proof of complete category spending. Source history, unresolved flows and household/price/period compatibility remain separate gates.",
            "Excluded, ambiguous, unmapped and outside-selection money is retained separately; the five buckets reconcile to confirmed observed consumption, including refunds.",
            "Zero assigned money means no confirmed records were mapped here; it is not a population benchmark or evidence of zero actual spending.",
            "Amounts retain the source currency. No exchange-rate conversion, inflation adjustment or period extrapolation is performed.",
        ])
        return CategoryMappingCoverageV1(status=status,mapping_version=self._policy.mapping_version,policy_sha256=self.digest,
            category_taxonomy=taxonomy,snapshot_id=self._policy.snapshot_id,scope=totals.scope.model_copy(deep=True),total_observed=total,
            evidence_filters=totals.evidence_filters.model_copy(deep=True),evidence_transaction_ids=list(totals.evidence_transaction_ids),
            **{name:CrosswalkAmountV1(**value) for name,value in buckets.items()},
            assignments=[CrosswalkAssignedV1(target=target,assigned_observed=CrosswalkAmountV1(**assigned[target.code])) for target in targets],
            decisions=decisions,unresolved_flow_count=totals.unresolved_flow_count,nonconsumption_count=totals.nonconsumption_count,limitations=limitations)


def load_crosswalk(path=CROSSWALK,*,directory=None):
    try:
        with Path(path).open("rb") as stream:
            content=stream.read(32769)
        if len(content)>32768:
            raise SnapshotError("CROSSWALK_TOO_LARGE")
        policy=json.loads(content)
        manifest,documents,_=load_snapshot() if directory is None else load_snapshot(directory)
        return CategoryCrosswalk(policy,manifest,documents)
    except (OSError,ValueError,KeyError,TypeError) as error:
        raise SnapshotError("VERIFIED_CROSSWALK_UNAVAILABLE") from error


@lru_cache(maxsize=1)
def bundled_crosswalk():
    return load_crosswalk()
