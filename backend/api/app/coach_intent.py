"""Bounded local EN/FI/ET selectors. Unknown text never becomes a guessed tool call."""
from datetime import date,datetime,timedelta,timezone
import json
import re
from typing import Annotated,Literal
from uuid import UUID
from zoneinfo import ZoneInfo

from pydantic import AwareDatetime,Field,StrictBool,StrictInt,StrictStr,ValidationError,model_validator

from .analysis_tools import (AnalysisToolRequestV2,LedgerSearchToolV1,SpendingToolV1,SpendingComparisonToolV1,SpendingReductionToolV1,
    PlanningReadToolV1,BankConnectionsToolV1,GoalListToolV1,InsightListToolV1,PopulationReferenceToolV1)
from .answer_cards import AnswerLocale
from .contracts import Contract,Currency
from .spending_habits import SpendingHabitsArgumentsV1
from .spending_comparison import comparison_window
from .identity import AuthError


class CoachQuestionV1(Contract):
    question: Annotated[StrictStr,Field(min_length=1,max_length=2000)]
    privacy: StrictBool = True
    card_locale: AnswerLocale = "en"
    currency: Currency = "EUR"
    account_ids: list[UUID] | None = Field(default=None,min_length=1,max_length=50)
    expected_data_version: Annotated[StrictInt,Field(ge=1,le=2**53-1)] | None = None
    conversation_context: Annotated[StrictStr,Field(max_length=600)] | None = None

    @model_validator(mode="after")
    def bounded_question(self):
        if not self.question.strip() or any(ord(c)<32 or 127<=ord(c)<=159 for c in self.question):
            raise ValueError("Use one nonempty question without control characters")
        if self.conversation_context is not None and any(ord(c)<32 or 127<=ord(c)<=159 for c in self.conversation_context):
            raise ValueError("Conversation context cannot contain control characters")
        if self.account_ids is not None and len(set(self.account_ids))!=len(self.account_ids):
            raise ValueError("Choose distinct account identities")
        return self


class CoachAnalysisIntentV1(Contract):
    kind: Literal["analysis"] = "analysis"
    tool: AnalysisToolRequestV2


class CoachHabitsIntentV1(Contract):
    kind: Literal["habits"] = "habits"
    arguments: SpendingHabitsArgumentsV1


CoachIntentV1=Annotated[CoachAnalysisIntentV1|CoachHabitsIntentV1,Field(discriminator="kind")]
Reason=Literal["SUPPORTED_QUERY","PERIOD_REQUIRED","PERIOD_INVALID","FILTER_REQUIRED","CHANGE_REQUIRED",
    "COMPARISON_REQUIRES_FULL_MONTH","PLANNING_REVIEW_REQUIRED","UNSUPPORTED_QUESTION","IDENTIFIER_NOT_ALLOWED"]


class CoachInterpretationV1(Contract):
    interpretation_version: Literal["coach-intent.v1"] = "coach-intent.v1"
    method: Literal["bounded_english_patterns","structured_model"] = "bounded_english_patterns"
    status: Literal["ready","clarification_required","review_required","unsupported"]
    reason: Reason
    message: str = Field(max_length=600)
    resolved_at: AwareDatetime
    timezone: Literal["Europe/Helsinki"] = "Europe/Helsinki"
    intent: CoachIntentV1 | None
    next_view: Literal["/plan"] | None = None

    @model_validator(mode="after")
    def coherent_intent(self):
        if (self.status=="ready")!=(self.intent is not None):
            raise ValueError("Only complete supported questions have an executable intent")
        return self


MESSAGES={
    "IDENTIFIER_NOT_ALLOWED":"Could you ask using a category or merchant name without account identifiers?",
    "SUPPORTED_QUERY":"The normalized read-only query and its exact scope are attached. Inspect the returned evidence before using the result.",
    "PERIOD_REQUIRED":"Choose an observation period, such as last month or from 2026-10-01 until 2026-11-01. No period has been assumed.",
    "PERIOD_INVALID":"Choose a valid period of one to 366 days. Use until for an excluded end date or through for an included end date.",
    "FILTER_REQUIRED":"Use a supported category, category \"exact source category\", or at \"merchant text\". Merchant text is a literal substring filter. Multiple or unclear filters need an explicit choice.",
    "CHANGE_REQUIRED":"Choose a reduction from 0% to 100% with at most two decimal places, or an exact EUR amount such as EUR 10.50, and one explicit category.",
    "COMPARISON_REQUIRES_FULL_MONTH":"A previous-month comparison needs one complete calendar month. Use the previous period for a matched day-count comparison.",
    "PLANNING_REVIEW_REQUIRED":"Review accounts, income, bills, essentials and buffer in the plan before asking for a dated spending or saving allowance. An existing quote is not permission for a different period.",
    "UNSUPPORTED_QUESTION":"This local interpreter supports bounded English read queries. Rephrase with explicit dates and filters, or use the existing financial forms. No query has been run.",
}
LOCAL_MESSAGES={
    "en": {
        "SUPPORTED_QUERY":"The answer uses the selected accounts and dated evidence attached below.",
        "PERIOD_REQUIRED":"Which period should I check, for example last month?",
        "PERIOD_INVALID":"Which valid period of one to 366 days should I check, with an explicit excluded end date?",
        "FILTER_REQUIRED":"Which single category or quoted merchant should I check?",
        "CHANGE_REQUIRED":"Which category and reduction from 0% to 100% should I use?",
        "COMPARISON_REQUIRES_FULL_MONTH":"Which complete calendar month should I compare with the month before?",
        "PLANNING_REVIEW_REQUIRED":"I cannot establish a safe spending or saving amount for the requested period. Review balances, income, bills, essentials and buffer in your plan; the available amount is unknown, not zero.",
        "UNSUPPORTED_QUESTION":"Which spending, transaction search, comparison or reduction would you like to check, and for which period?",
    },
    "fi": {
        "IDENTIFIER_NOT_ALLOWED":"Voitko kysyä kululuokan tai kauppiaan nimellä ilman tilitunnuksia?",
        "SUPPORTED_QUERY":"Vastaus perustuu valittuihin tileihin ja mukana oleviin päivättyihin lähdetietoihin.",
        "PERIOD_REQUIRED":"Minkä ajanjakson tarkistan, esimerkiksi viime kuun?",
        "PERIOD_INVALID":"Minkä kelvollisen 1–366 päivän jakson tarkistan, kun loppupäivä ei kuulu jaksoon?",
        "FILTER_REQUIRED":"Minkä yhden kululuokan tai lainausmerkeissä annetun kauppiaan tarkistan?",
        "CHANGE_REQUIRED":"Mitä kululuokkaa ja 0–100 prosentin vähennystä käytän?",
        "COMPARISON_REQUIRES_FULL_MONTH":"Mitä kokonaista kalenterikuukautta vertaan sitä edeltävään kuukauteen?",
        "PLANNING_REVIEW_REQUIRED":"En voi määrittää turvallista käyttövaraa tai säästösummaa pyydetylle jaksolle. Tarkista suunnitelmasta saldot, tulot, laskut, välttämättömät menot ja puskuri; käytettävissä oleva summa on tuntematon, ei nolla.",
        "UNSUPPORTED_QUESTION":"Mitä kulutusta, tapahtumia, vertailua tai vähennystä haluat tarkastella ja miltä ajanjaksolta?",
    },
    "et": {
        "IDENTIFIER_NOT_ALLOWED":"Kas saad küsida kululiigi või kaupmehe nime järgi ilma kontotunnusteta?",
        "SUPPORTED_QUERY":"Vastus põhineb valitud kontodel ja lisatud kuupäevastatud tõenditel.",
        "PERIOD_REQUIRED":"Millist perioodi kontrollin, näiteks eelmist kuud?",
        "PERIOD_INVALID":"Millist kehtivat 1–366 päeva pikkust perioodi kontrollin, kui lõppkuupäev jääb välja?",
        "FILTER_REQUIRED":"Millist ühte kululiiki või jutumärkides kaupmeest kontrollin?",
        "CHANGE_REQUIRED":"Millist kululiiki ja 0–100 protsendi suurust vähendust kasutan?",
        "COMPARISON_REQUIRES_FULL_MONTH":"Millist tervet kalendrikuud võrdlen sellele eelneva kuuga?",
        "PLANNING_REVIEW_REQUIRED":"Ma ei saa määrata turvalist kulutamis- ega säästusummat soovitud perioodiks. Kontrolli plaanis saldosid, tulusid, arveid, vältimatuid kulusid ja puhvrit; kasutatav summa on teadmata, mitte null.",
        "UNSUPPORTED_QUESTION":"Milliseid kulutusi, tehinguid, võrdlust või vähendust soovid kontrollida ja millisel perioodil?",
    },
}


def interpretation_message(reason,locale):
    return LOCAL_MESSAGES.get(locale,MESSAGES).get(reason,MESSAGES[reason])


def question_has_identifiers(text):
    return bool(re.search(r"\b[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\b|\b[A-Z]{2}\d{2}(?:[ -]?[A-Z0-9]){11,30}\b",text,re.I))


ALIASES={**dict.fromkeys(("dining out","dining","ravintolat","ravintoloihin","ravintolakuluja","ulkona syöminen","restoranid","restoranidele","restoranikulusid","väljas söömine"),"dining"),
    **dict.fromkeys(("taxis","taxi","taksot","takseihin","taksimatkat","takso","taksole","taksodele","taksod","taksosõidud"),"taxi"),
    **dict.fromkeys(("groceries","ruokaostokset","ruokaostoksiin","toidukaubad","toidukaupadele"),"groceries"),
    **dict.fromkeys(("coffee","kahvi","kahviin","kahvikuluja","kohv","kohvile","kohvikulusid"),"coffee")}
PERIOD=re.compile(r"(?:^|\s)(last month|this month|last week|this week|from \d{4}-\d{2}-\d{2} (?:until|through|to) \d{4}-\d{2}-\d{2}|on \d{4}-\d{2}-\d{2})$",re.I)
MONTHS={name:index for names in (
    "January February March April May June July August September October November December".lower().split(),
    "tammikuussa helmikuussa maaliskuussa huhtikuussa toukokuussa kesäkuussa heinäkuussa elokuussa syyskuussa lokakuussa marraskuussa joulukuussa".split(),
    "jaanuaris veebruaris märtsis aprillis mais juunis juulis augustis septembris oktoobris novembris detsembris".split()
) for index,name in enumerate(names,1)}


class QuestionContext(Contract):
    """Untrusted selectors only; never account authority, records or instructions."""
    start: date
    end_exclusive: date
    tool: Literal["spending_totals","ledger_transactions","spending_comparison","spending_reduction","habits"] = "spending_totals"
    category: str | None = Field(default=None,min_length=1,max_length=100)
    merchant: str | None = Field(default=None,min_length=1,max_length=200)
    reduction_basis_points: StrictInt | None = Field(default=None,ge=0,le=10000)
    comparison_mode: Literal["previous_period","previous_month"] | None = None

    @model_validator(mode="after")
    def valid_selectors(self):
        if not 1<=(self.end_exclusive-self.start).days<=366: raise ValueError("Invalid context window")
        for text in (self.category,self.merchant):
            if text is not None and (not text.strip() or question_has_identifiers(text) or any(ord(c)<32 or 127<=ord(c)<=159 for c in text)):
                raise ValueError("Invalid context filter")
        return self


def question_context(raw):
    if not raw: return None
    def unique(pairs):
        values={}
        for key,value in pairs:
            if key in values: raise ValueError("Duplicate selector")
            values[key]=value
        return values
    try:
        values=json.loads(raw,object_pairs_hook=unique)
        return QuestionContext.model_validate_json(json.dumps(values),strict=True)
    except (ValueError,TypeError,ValidationError): return None


def normalize_local_question(text,now):
    # Normalize only outside JSON-quoted literals: merchant/source names remain exact.
    substitutions=((r"\b(?:viime kuussa|viime kuun|eelmisel kuul)\b","last month"),
        (r"\b(?:tässä kuussa|sel kuul)\b","this month"),
        (r"\b(?:viime viikolla|eelmisel nädalal)\b","last week"),
        (r"\b(?:tällä viikolla|sel nädalal)\b","this week"),
        (r"\b(?:paikassa|kauppiaalta|kaupmehelt)\b","at"),
        (r"\b(?:kategoriassa|kululuokassa|kategoorias)\b","category"))
    pieces=re.split(r'("(?:\\.|[^"\\])*")',text)
    for index in range(0,len(pieces),2):
        for pattern,replacement in substitutions: pieces[index]=re.sub(pattern,replacement,pieces[index],flags=re.I)
        pieces[index]=re.sub(r"\b(?:alkaen|alates) (\d{4}-\d{2}-\d{2}) (?:kunnes|kuni) (\d{4}-\d{2}-\d{2})\b",r"from \1 until \2",pieces[index],flags=re.I)
    text="".join(pieces)
    prefixes=((r"^(?:(?:paljonko|kuinka paljon) (?:käytin|kulutin)|kui palju (?:kulutasin|maksin))\b","How much did I spend"),
        (r"^(?:näytä (?:kulut|kulutukseni)|näita (?:kulutusi|kulusid))\b","Show spending"),
        (r"^(?:näytä (?:tapahtumat|tilitapahtumat)|näita (?:tehinguid|tehingud))\b","Show transactions"),
        (r"^(?:millainen kuluttaja (?:olen|olin)|milline kulutaja (?:olen|olin))\b","Describe spending habits"),
        (r"^(?:vertaa (?:kulutustani|kulutusta)|võrdle (?:mu )?kulutusi)\b","Compare spending"))
    for pattern,replacement in prefixes: text=re.sub(pattern,replacement,text,flags=re.I)
    text=re.sub(r"^näytä last month kulutus$","Show spending last month",text,flags=re.I)
    text=re.sub(r" (?:edelliseen kuukauteen|eelmise kuuga)$"," with the previous month",text,flags=re.I)
    match=re.fullmatch(r"(?:mitä jos vähennän|mis (?:siis, )?kui vähendan) (.+?) ([0-9]{1,3}(?:[.,][0-9]{1,2})?)%(?: võrra)? (.+)",text,re.I)
    if match: text=f"Reduce {match[1]} by {match[2].replace(',','.')}% {match[3]}"
    text=re.sub(r"^What if I (?:cut|reduced)\s+","Reduce ",text,flags=re.I)
    named=re.search(r"(?:^|\s)(?:in\s+)?("+"|".join(MONTHS)+r")(?:\s+(\d{4}))?$",text,re.I)
    if named:
        today=now.astimezone(ZoneInfo("Europe/Helsinki")).date();month=MONTHS[named[1].casefold()]
        year=int(named[2]) if named[2] else today.year-(month>today.month)
        try:
            start=date(year,month,1);end=date(year+1,1,1) if month==12 else date(year,month+1,1)
        except (ValueError,OverflowError): raise Clarification("PERIOD_INVALID") from None
        text=text[:named.start()]+f" from {start} until {end}"
    return text


def followup_question(text,body,now):
    match=re.fullmatch(r"(?:and|what about|entä|aga) (.+)",text,re.I)
    if match is None: return None
    context=question_context(body.conversation_context)
    if context is None: raise Clarification("PERIOD_REQUIRED")
    target=match[1]
    if target.casefold() in ("the month before","the previous month","edellinen kuukausi","sitä edeltävä kuukausi","eelmine kuu"):
        end=context.start.replace(day=1);start=(end-timedelta(days=1)).replace(day=1)
        target=f"from {start} until {end}"
    else: target=normalize_local_question(target,now)
    remaining,start,end=observation_period(target,now)
    # The entire follow-up must be a period selector.
    if remaining: raise Clarification("FILTER_REQUIRED")
    selected=""
    if context.category: selected+=' category '+json.dumps(context.category,ensure_ascii=False)
    if context.merchant: selected+=' at '+json.dumps(context.merchant,ensure_ascii=False)
    prefix={"spending_totals":"Show spending","ledger_transactions":"Show transactions","habits":"Describe spending habits",
        "spending_comparison":"Compare spending","spending_reduction":"Reduce"}[context.tool]
    if context.tool=="spending_reduction":
        if not context.category or context.reduction_basis_points is None: raise Clarification("CHANGE_REQUIRED")
        whole,fraction=divmod(context.reduction_basis_points,100);selected+=f" by {whole}.{fraction:02d}%"
    question=f"{prefix}{selected} from {start} until {end}"
    if context.tool=="spending_comparison":
        if context.comparison_mode is None: raise Clarification("COMPARISON_REQUIRES_FULL_MONTH")
        question+=" with the previous "+("month" if context.comparison_mode=="previous_month" else "period")
    return question


class Clarification(ValueError):
    pass


def observation_period(text,now):
    match=PERIOD.search(text)
    if match is None: raise Clarification("PERIOD_REQUIRED")
    phrase=match[1].lower();today=now.astimezone(ZoneInfo("Europe/Helsinki")).date()
    try:
        if phrase=="last month":
            end=today.replace(day=1);start=(end-timedelta(days=1)).replace(day=1)
        elif phrase=="this month": start,end=today.replace(day=1),today+timedelta(days=1)
        elif phrase in ("this week","last week"):
            monday=today-timedelta(days=today.weekday())
            start,end=(monday,today+timedelta(days=1)) if phrase=="this week" else (monday-timedelta(days=7),monday)
        elif phrase.startswith("on "):
            start=date.fromisoformat(phrase[3:]);end=start+timedelta(days=1)
        else:
            _,first,connector,last=phrase.split()
            if connector=="to": raise ValueError("Ambiguous end date")
            start,end=date.fromisoformat(first),date.fromisoformat(last)
            if connector=="through": end+=timedelta(days=1)
        if not 1<=(end-start).days<=366: raise ValueError("Unbounded observation period")
    except (ValueError,OverflowError): raise Clarification("PERIOD_INVALID") from None
    return text[:match.start()].strip(),start,end


def filters(text,*,bare_category=False):
    remaining=text.strip();result={}
    if bare_category:
        alias=next((key for key in sorted(ALIASES,key=len,reverse=True) if remaining[:len(key)].casefold()==key and
            (len(remaining)==len(key) or remaining[len(key)].isspace())),None)
        if alias is not None: result["category"]=ALIASES[alias];remaining=remaining[len(alias):].strip()
    while remaining:
        marker=re.match(r"(at|in\s+category|category|on)\s+",remaining,re.I)
        if marker is None: raise Clarification("FILTER_REQUIRED")
        field="merchant" if marker[1].lower()=="at" else "category"
        if field in result: raise Clarification("FILTER_REQUIRED")
        remaining=remaining[marker.end():]
        if remaining.startswith('"'):
            try: value,offset=json.JSONDecoder().raw_decode(remaining)
            except ValueError: raise Clarification("FILTER_REQUIRED") from None
            if not isinstance(value,str) or not value.strip() or len(value)>(200 if field=="merchant" else 100) or any(ord(c)<32 or 127<=ord(c)<=159 for c in value):
                raise Clarification("FILTER_REQUIRED")
            remaining=remaining[offset:]
            if remaining and not remaining[0].isspace(): raise Clarification("FILTER_REQUIRED")
        elif field=="category":
            alias=next((key for key in sorted(ALIASES,key=len,reverse=True) if remaining[:len(key)].casefold()==key and
                (len(remaining)==len(key) or remaining[len(key)].isspace())),None)
            if alias is None: raise Clarification("FILTER_REQUIRED")
            value=ALIASES[alias];remaining=remaining[len(alias):]
        else: raise Clarification("FILTER_REQUIRED")
        result[field]=value;remaining=remaining.strip()
    return result


def reduction(text,currency):
    percent=re.fullmatch(r"([0-9]{1,3})(?:\.([0-9]{1,2}))?%",text)
    if percent:
        bps=int(percent[1])*100+int((percent[2] or "").ljust(2,"0"))
        if bps<=10000: return {"kind":"percentage","reduction_basis_points":bps}
    fixed=re.fullmatch(r"(?:EUR\s+|€\s*)([0-9]{1,15})(?:\.([0-9]{1,2}))?",text,re.I)
    if fixed and currency=="EUR":
        amount=int(fixed[1])*100+int((fixed[2] or "").ljust(2,"0"))
        if amount<=2**53-1: return {"kind":"fixed_amount","reduction_minor":amount}
    raise Clarification("CHANGE_REQUIRED")


def interpret_question(body,*,now):
    body=CoachQuestionV1.model_validate(body.model_dump(mode="python"),strict=True)
    if not isinstance(now,datetime) or now.utcoffset() is None: raise ValueError("A server-owned aware instant is required")
    now=now.astimezone(timezone.utc)
    text=body.question.strip().rstrip("?.").strip()
    def result(reason,intent=None,*,status="clarification_required",next_view=None):
        return CoachInterpretationV1(status="ready" if intent else status,reason=reason,message=interpretation_message(reason,body.card_locale),
            resolved_at=now,intent=intent,next_view=next_view)
    if question_has_identifiers(text): return result("IDENTIFIER_NOT_ALLOWED")
    try: text=followup_question(text,body,now) or normalize_local_question(text,now)
    except Clarification as error: return result(str(error))
    if re.fullmatch(r"(?:(?:what is safe for me to|how much (?:can|could) i safely) (?:spend|save)|(?:paljonko|kuinka paljon) voin (?:turvallisesti )?(?:käyttää|kuluttaa|säästää)|kui palju (?:võin|saan) (?:turvaliselt )?(?:kulutada|säästa))(?: (?:this|last) (?:week|month))?",text,re.I):
        return result("PLANNING_REVIEW_REQUIRED",status="review_required",next_view="/plan")
    simple={"show my reviewed plan":PlanningReadToolV1,"show my bank connections":BankConnectionsToolV1,
        "show my goals":GoalListToolV1,"show my coaching insights":InsightListToolV1,"show population benchmarks":PopulationReferenceToolV1}
    for phrase,model in simple.items():
        if text.casefold()==phrase:
            # Account/currency/version selectors belong to ledger reads. Do not
            # silently ignore an explicit narrower selector for another tool.
            if body.account_ids is not None or body.expected_data_version is not None or body.currency!="EUR":
                return result("UNSUPPORTED_QUESTION",status="unsupported")
            names={PlanningReadToolV1:"planning_read",BankConnectionsToolV1:"bank_connections",GoalListToolV1:"goal_list",
                InsightListToolV1:"insight_list",PopulationReferenceToolV1:"population_reference"}
            return result("SUPPORTED_QUERY",CoachAnalysisIntentV1(tool=model(name=names[model],arguments={})))
    transaction_search=re.match(r"show (?:my )?transactions(?:\s|$)",text,re.I)
    spending=re.match(r"(?:how much did i spend|show (?:my )?spending)(?:\s|$)",text,re.I)
    habits=re.match(r"(?:what kind of spender (?:am|was) i|describe (?:my )?spending habits)(?:\s|$)",text,re.I)
    comparison=re.fullmatch(r"compare (?:my )?spending (.+) with (?:the )?previous (month|period)",text,re.I)
    scenario=re.match(r"(?:how much could i save if i reduced|reduce)\s+",text,re.I)
    if not any((transaction_search,spending,habits,comparison,scenario)):
        return result("UNSUPPORTED_QUESTION",status="unsupported")
    try:
        tail=comparison[1] if comparison else text[(transaction_search or spending or habits or scenario).end():]
        tail=normalize_local_question(tail,now)
        scope,start,end=observation_period(tail,now)
        args={"start":start,"end_exclusive":end,"currency":body.currency,"account_ids":body.account_ids,
            "expected_data_version":body.expected_data_version}
        if transaction_search:
            tool=LedgerSearchToolV1(name="ledger_transactions",arguments={**args,**filters(scope,bare_category=True),"status":"booked","spending_only":False,"limit":50})
        elif scenario:
            separators=list(re.finditer(r"\s+by\s+",scope,re.I))
            if not separators: raise Clarification("CHANGE_REQUIRED")
            separator=separators[-1];scope,change=scope[:separator.start()].strip(),scope[separator.end():].strip()
            selected=filters(scope,bare_category=True)
            if "category" not in selected: raise Clarification("CHANGE_REQUIRED")
            tool=SpendingReductionToolV1(name="spending_reduction",arguments={**args,**selected,"change":reduction(change,body.currency)})
        elif comparison:
            mode="previous_month" if comparison[2].lower()=="month" else "previous_period"
            if mode=="previous_month" and (start.day!=1 or end.day!=1 or (end-start).days not in (28,29,30,31)):
                raise Clarification("COMPARISON_REQUIRES_FULL_MONTH")
            try: comparison_window(start,end,mode)
            except AuthError: raise Clarification("PERIOD_INVALID") from None
            tool=SpendingComparisonToolV1(name="spending_comparison",arguments={**args,**filters(scope,bare_category=True),"mode":mode})
        elif habits:
            return result("SUPPORTED_QUERY",CoachHabitsIntentV1(arguments={**args,**filters(scope,bare_category=True)}))
        else: tool=SpendingToolV1(name="spending_totals",arguments={**args,**filters(scope,bare_category=True)})
        return result("SUPPORTED_QUERY",CoachAnalysisIntentV1(tool=tool))
    except Clarification as error: return result(str(error))
    except (ValueError,OverflowError): return result("PERIOD_INVALID")
