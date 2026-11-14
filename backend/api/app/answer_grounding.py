"""Deterministic financial facts; free-form model prose is never an answer artifact."""
from datetime import date,datetime
import hashlib
import json
from typing import Annotated,Literal

from pydantic import Field,StrictInt,TypeAdapter,ValidationError,model_validator

from .analysis_tools import AnalysisToolResultV2
from .contracts import Contract,Currency,Minor
from .identity import AuthError
from .spending_comparison import compare_spending,comparison_window
from .spending_scenario import SpendingReductionArgumentsV1,spending_reduction

Kind=Literal["money","date","count","basis_points"]
Meaning=Literal["gross_booked_expenses","booked_refunds","net_observed_spending","expense_count","refund_count",
    "window_start","window_end_exclusive","baseline_net_observed_spending","current_net_observed_spending",
    "net_observed_change","net_change_basis_points","hypothetical_cost_reduction","counterfactual_net_spending",
    "reviewed_shared_surplus","planning_observed_at","planning_expires_at","requested_until_exclusive","protected_through"]
FactId=Annotated[str,Field(pattern=r"^[a-z][a-z0-9_.]{0,99}$")]
Value=Minor|Annotated[str,Field(max_length=100)]|None
RESULT=TypeAdapter(AnalysisToolResultV2)


class AnswerClaimV1(Contract):
    fact_id: FactId
    kind: Kind
    meaning: Meaning
    value: Value
    currency: Currency | None

    @model_validator(mode="after")
    def typed_value(self):
        if self.kind=="money":
            if self.currency is None or self.value is not None and type(self.value) is not int:
                raise ValueError("Money facts require exact minor units and currency")
        elif self.currency is not None: raise ValueError("Only money facts have a currency")
        if self.kind in ("count","basis_points") and self.value is not None and type(self.value) is not int:
            raise ValueError("Counts and basis points require integers")
        if self.kind=="count" and self.value is not None and self.value<0: raise ValueError("Counts are nonnegative")
        if self.kind=="date" and self.value is not None:
            if not isinstance(self.value,str): raise ValueError("Dates require explicit ISO strings")
            if "T" in self.value:
                value=datetime.fromisoformat(self.value.replace("Z","+00:00"))
                if value.utcoffset() is None: raise ValueError("Instants require an offset")
            else: date.fromisoformat(self.value)
        return self


class AnswerFactV1(AnswerClaimV1):
    source_pointer: str = Field(pattern=r"^/result(?:/[A-Za-z0-9_]+)+$",max_length=200)
    interpretation: Literal["observed","hypothetical","reviewed_plan"]


class GroundedAnswerV1(Contract):
    answer_version: Literal["financial-answer.v1"] = "financial-answer.v1"
    status: Literal["ready","limited","blocked"]
    presentation: Literal["observed_spending","spending_comparison","historical_scenario","reviewed_plan","tool_details"]
    evidence_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    artifact: AnalysisToolResultV2
    facts: list[AnswerFactV1] = Field(max_length=20)
    reasons: list[str] = Field(max_length=10)
    claims_status: Literal["not_requested","accepted","replaced"]
    accepted_fact_ids: list[FactId] = Field(max_length=20)
    limitations: list[str] = Field(max_length=10)


def ground_answer(result,claims=None):
    # Revalidate/copy nested objects, including forged model_construct values.
    # No prior conversation, body/owner selector or model sentence is authority.
    try: artifact=RESULT.validate_python(result.model_dump(mode="python"),strict=True)
    except (AttributeError,TypeError,ValueError): raise AuthError("GROUNDING_EVIDENCE_INVALID",409) from None
    raw=artifact.model_dump(mode="json")
    facts=[];reasons=[];status="ready";presentation="tool_details"
    def reconciled(totals):
        scope,filters=totals.scope,totals.evidence_filters
        if totals.gross_minor-totals.refunds_minor!=totals.net_minor or scope.start>=scope.end_exclusive or (
            scope.start,scope.end_exclusive,scope.currency)!=(filters.start,filters.end_exclusive,filters.currency) or (
            len(set(scope.account_ids))!=len(scope.account_ids)) or any(
            not 0<=getattr(totals,key)<=2**53-1 for key in ("expense_count","refund_count","unresolved_flow_count","nonconsumption_count")):
            raise AuthError("GROUNDING_EVIDENCE_INVALID",409)
        if filters.account_ids is not None and (len(set(filters.account_ids))!=len(filters.account_ids) or set(filters.account_ids)!=set(scope.account_ids)):
            raise AuthError("GROUNDING_EVIDENCE_INVALID",409)
    def value(pointer):
        current=raw
        for key in pointer.split("/")[1:]: current=current[key]
        return current
    def fact(identifier,pointer,kind,meaning,interpretation="observed",currency=None):
        facts.append(AnswerFactV1(fact_id=identifier,source_pointer=pointer,kind=kind,meaning=meaning,
            interpretation=interpretation,value=value(pointer),currency=currency))
    def window(prefix,identifier):
        fact(identifier+".start",prefix+"/scope/start","date","window_start")
        fact(identifier+".end",prefix+"/scope/end_exclusive","date","window_end_exclusive")
    if artifact.name=="spending_totals":
        totals=artifact.result;presentation="observed_spending"
        reconciled(totals)
        for field,meaning in (("gross_minor","gross_booked_expenses"),("refunds_minor","booked_refunds"),("net_minor","net_observed_spending")):
            fact(field,"/result/"+field,"money",meaning,currency=totals.scope.currency)
        for field in ("expense_count","refund_count"): fact(field,"/result/"+field,"count",field)
        window("/result","window")
        if totals.scope.dataset_coverage!="covered_synthetic_snapshot" or not totals.scope.account_ids: reasons.append("INCOMPLETE_HISTORY")
        if totals.unresolved_flow_count: reasons.append("UNRESOLVED_FLOWS")
        if reasons: status="limited"
    elif artifact.name=="spending_comparison":
        compared=artifact.result;presentation="spending_comparison"
        reconciled(compared.current);reconciled(compared.baseline)
        current,baseline=compared.current.scope,compared.baseline.scope
        before,after=compared.baseline.evidence_filters,compared.current.evidence_filters
        if (after.category,after.merchant,after.status,after.spending_only)!=(before.category,before.merchant,before.status,before.spending_only):
            raise AuthError("GROUNDING_EVIDENCE_INVALID",409)
        try:
            expected_window=comparison_window(current.start,current.end_exclusive,compared.mode,
                baseline.start if compared.mode=="custom" else None,baseline.end_exclusive if compared.mode=="custom" else None)
            rebuilt=compare_spending(compared.current,compared.baseline,compared.mode)
            if expected_window!=(baseline.start,baseline.end_exclusive) or rebuilt!=compared:
                raise ValueError("Inconsistent comparison")
        except (AuthError,ValueError,TypeError,ArithmeticError):
            raise AuthError("GROUNDING_EVIDENCE_INVALID",409) from None
        for prefix,meaning in (("baseline","baseline_net_observed_spending"),("current","current_net_observed_spending"),("change","net_observed_change")):
            fact(prefix+".net_minor","/result/"+prefix+"/net_minor","money",meaning,currency=compared.current.scope.currency)
        fact("change.basis_points","/result/change/net_change_basis_points","basis_points","net_change_basis_points")
        window("/result/current","current");window("/result/baseline","baseline")
        if compared.status!="covered_comparison": status="limited";reasons.append("LIMITED_COMPARISON")
    elif artifact.name=="spending_reduction":
        scenario=artifact.result;presentation="historical_scenario"
        reconciled(scenario.baseline)
        scope,filters=scenario.baseline.scope,scenario.baseline.evidence_filters
        try:
            body=SpendingReductionArgumentsV1(start=scope.start,end_exclusive=scope.end_exclusive,currency=scope.currency,
                account_ids=filters.account_ids,category=filters.category,merchant=filters.merchant,change=scenario.change)
            if spending_reduction(body,scenario.baseline,now=scenario.as_of)!=scenario:
                raise ValueError("Inconsistent counterfactual")
        except (AuthError,ValueError,TypeError,ArithmeticError):
            raise AuthError("GROUNDING_EVIDENCE_INVALID",409) from None
        fact("baseline.net_minor","/result/baseline/net_minor","money","net_observed_spending",currency=scenario.baseline.scope.currency)
        fact("reduction.amount_minor","/result/result/amount_minor","money","hypothetical_cost_reduction","hypothetical",scenario.result.currency)
        fact("counterfactual.net_minor","/result/counterfactual_net_minor","money","counterfactual_net_spending","hypothetical",scenario.result.currency)
        window("/result/baseline","window")
        if scenario.status=="blocked": status="blocked";reasons.append("SCENARIO_BLOCKED")
    elif artifact.name=="planning_read":
        plan=artifact.result.plan;presentation="reviewed_plan"
        if plan is None: status="blocked";reasons.append("PLAN_MISSING")
        else:
            analysis=plan.analysis
            evidence_matches=(analysis.as_of,analysis.data_version,analysis.evidence.plan_id,analysis.evidence.data_version,analysis.evidence.plan_version)==(
                plan.as_of,plan.data_version,plan.id,plan.data_version,plan.plan_version)
            current_valid=not plan.current or (plan.state=="active" and plan.period is not None and
                plan.as_of<=artifact.result.evaluated_at<plan.expires_at)
            period_valid=plan.period is None or (plan.period.as_of==plan.as_of and
                plan.period.requested_from<plan.period.requested_to_exclusive<=plan.period.protection_through)
            status_valid=(analysis.status=="estimated" and analysis.result.amount_minor is not None and not analysis.blockers) or (
                analysis.status=="blocked" and analysis.result.amount_minor is None and bool(analysis.blockers))
            history_valid=plan.current or (plan.period is None and all(getattr(analysis.result,key) is None for key in (
                "amount_minor","minimum_headroom_minor","minimum_headroom_at","surplus_minor","shortfall_minor")))
            if not all((evidence_matches,current_valid,period_valid,status_valid,history_valid)):
                raise AuthError("GROUNDING_EVIDENCE_INVALID",409)
            fact("plan.amount_minor","/result/plan/analysis/result/amount_minor","money","reviewed_shared_surplus","reviewed_plan",analysis.result.currency)
            fact("plan.as_of","/result/plan/as_of","date","planning_observed_at","reviewed_plan")
            fact("plan.expires","/result/plan/expires_at","date","planning_expires_at","reviewed_plan")
            if plan.period is not None:
                fact("plan.requested_until","/result/plan/period/requested_to_exclusive","date","requested_until_exclusive","reviewed_plan")
                fact("plan.protected_through","/result/plan/period/protection_through","date","protected_through","reviewed_plan")
            if not plan.current or analysis.status=="blocked": status="blocked";reasons.append("PLAN_BLOCKED")
    else: status="limited";reasons.append("FACT_PROJECTION_NOT_IMPLEMENTED")
    claims_status="not_requested";accepted=[]
    if claims is not None:
        try:
            if not isinstance(claims,(list,tuple)) or not 1<=len(claims)<=20: raise ValueError("Bounded explicit claims required")
            proposed=TypeAdapter(Annotated[list[AnswerClaimV1],Field(min_length=1,max_length=20)]).validate_python(
                [claim.model_dump(mode="python") if isinstance(claim,AnswerClaimV1) else claim for claim in claims],strict=True)
            by_id={item.fact_id:item for item in facts}
            if len({claim.fact_id for claim in proposed})!=len(proposed): raise ValueError("Duplicate claim")
            for claim in proposed:
                expected=by_id.get(claim.fact_id)
                if expected is None or claim.model_dump()!=expected.model_dump(include=set(AnswerClaimV1.model_fields)):
                    raise ValueError("Unsupported claim")
            claims_status="accepted";accepted=[claim.fact_id for claim in proposed]
        except (ValidationError,TypeError,ValueError): claims_status="replaced"
    digest=hashlib.sha256(json.dumps(raw,ensure_ascii=True,sort_keys=True,separators=(",",":"),allow_nan=False).encode()).hexdigest()
    return GroundedAnswerV1(status=status,presentation=presentation,evidence_sha256=digest,artifact=artifact,facts=facts,
        reasons=reasons,claims_status=claims_status,accepted_fact_ids=accepted,limitations=[
            "Facts copy exact typed service values and meanings. Historical spending and hypothetical reductions are not spending or saving allowances.",
            "Null remains unknown or blocked; an observed zero retains its searched scope and coverage limitations.",
            "The complete artifact retains account/source/date/version evidence, assumptions and limitations; this content hash is not an access grant.",
            "No free-form model sentence is validated or rendered here. Unsupported structured claims are replaced by the deterministic artifact.",
            "Question interpretation, current authorization on later retrieval and durable conversation grounding remain separate gates; optional localized cards are a separate deterministic projection."])
