"""Localized templates over freshly grounded facts; no model-written prose."""
from typing import Annotated,Literal

from pydantic import Field

from .answer_grounding import GroundedAnswerV1,ground_answer
from .contracts import Contract
from .identity import AuthError

AnswerLocale=Literal["en","fi","sv"]
Text=Annotated[str,Field(min_length=1,max_length=600)]


class AnswerCardRowV1(Contract):
    fact_id: str = Field(max_length=100)
    label: Text
    value_text: Text


class AnswerCardV1(Contract):
    card_version: Literal["financial-answer-card.v1"] = "financial-answer-card.v1"
    locale: AnswerLocale
    title: Text
    summary: Text
    status_label: Text
    rows: list[AnswerCardRowV1] = Field(max_length=20)
    notices: list[Text] = Field(max_length=12)
    answer: GroundedAnswerV1


# Authored learning/result copy. Untrusted merchant/category text stays inside
# the attached evidence and is never interpolated into these templates.
COPY={
    "en": {
        "titles": ["Observed spending","Spending comparison","Historical what-if","Reviewed plan","Service evidence"],
        "summaries": [
            "Booked expenses minus refunds in the selected period. This describes past records, not a spending allowance.",
            "These are two observed booking-date windows. Their difference is not a forecast or a spending allowance.",
            "This is a hypothetical reduction of past costs. No transaction is changed and no money is moved.",
            "Spending and saving share the reviewed surplus. The quote can expire; refresh it before making a decision.",
            "The complete service result is attached. A concise financial card is not yet available for this tool.",
        ],
        "statuses": {"ready":"Ready to inspect","limited":"Limited evidence","blocked":"Review required"},
        "labels": ["Gross booked expenses","Booked refunds","Net observed spending","Expense records","Refund records",
            "Period start","Period end (excluded)","Reference period: net spending","Selected period: net spending",
            "Change in net spending","Change in net spending (%)","Hypothetical cost reduction","Counterfactual net spending",
            "Reviewed shared surplus","Planning as-of instant","Quote expires at","Requested until (excluded)","Protected through"],
        "periods": {"current":"Selected period","baseline":"Reference period"},
        "unavailable":"Unavailable", "minor":"minor units",
        "scope":"Values apply only to the accounts, filters and dated sources in the attached evidence. They do not confirm complete finances.",
        "reasons": {
            "INCOMPLETE_HISTORY":"Source history does not cover the whole selected scope. No matching records do not prove there was no spending.",
            "UNRESOLVED_FLOWS":"Some records have an unresolved economic purpose. Review their classification.",
            "LIMITED_COMPARISON":"The observed windows do not support an unqualified spending comparison. Review their scope and coverage.",
            "SCENARIO_BLOCKED":"The historical scenario is blocked. Review the source history, classification and requested reduction in the evidence.",
            "PLAN_MISSING":"No reviewed plan is available. The available amount is unknown, not zero.",
            "PLAN_BLOCKED":"This plan cannot provide a current allowance. Refresh its sources and review its inputs.",
            "FACT_PROJECTION_NOT_IMPLEMENTED":"Use the attached typed service evidence; no concise financial facts have been projected for this tool.",
        },
        "unequal":"The periods have different numbers of calendar days. Raw totals are not adjusted for duration.",
        "overlap":"The periods overlap and share records. They are not independent before-and-after observations.",
    },
    "fi": {
        "titles": ["Havaittu kulutus","Kulutuksen vertailu","Menneen kulutuksen vaihtoehto","Tarkistettu suunnitelma","Palvelun lähdetiedot"],
        "summaries": [
            "Kirjatut menot vähennettynä hyvityksillä valitulla jaksolla. Tämä kuvaa aiempia kirjauksia, ei käyttövaraa.",
            "Tässä verrataan kahden kirjauspäivien mukaisen jakson havaintoja. Erotus ei ole ennuste tai käyttövara.",
            "Tämä on oletettu menneiden kulujen vähennys. Kirjauksia ei muuteta eikä rahaa siirretä.",
            "Kuluttaminen ja säästäminen käyttävät samaa tarkistettua ylijäämää. Arvio voi vanhentua; päivitä se ennen päätöstä.",
            "Palvelun täydelliset lähdetiedot ovat mukana. Tälle toiminnolle ei vielä ole tiivistä talouskorttia.",
        ],
        "statuses": {"ready":"Valmis tarkasteltavaksi","limited":"Rajalliset tiedot","blocked":"Tarkistus tarvitaan"},
        "labels": ["Kirjatut menot (brutto)","Kirjatut hyvitykset","Havaittu nettokulutus","Menokirjausten määrä","Hyvityskirjausten määrä",
            "Jakson alku","Jakson loppu (ei mukana)","Vertailujakson nettokulutus","Tarkasteltavan jakson nettokulutus",
            "Nettokulutuksen muutos","Nettokulutuksen muutos (%)","Oletettu kulujen vähennys","Nettokulutus oletetun muutoksen jälkeen",
            "Tarkistettu yhteinen ylijäämä","Suunnitelman tarkasteluhetki","Arvion voimassaolo päättyy","Pyydetyn jakson loppu (ei mukana)","Suojattu ajankohtaan asti"],
        "periods": {"current":"Tarkasteltava jakso","baseline":"Vertailujakso"},
        "unavailable":"Ei saatavilla", "minor":"valuutan alayksikköä",
        "scope":"Arvot koskevat vain mukana olevien lähdetietojen tilejä, rajauksia ja ajankohtia. Ne eivät vahvista koko taloudellista tilannetta.",
        "reasons": {
            "INCOMPLETE_HISTORY":"Lähdehistoria ei kata koko valittua rajausta. Osumien puuttuminen ei osoita, ettei menoja ollut.",
            "UNRESOLVED_FLOWS":"Joidenkin kirjausten taloudellinen tarkoitus on selvittämättä. Tarkista niiden luokittelu.",
            "LIMITED_COMPARISON":"Havaintojaksojen perusteella ei voi tehdä varauksetonta kulutusvertailua. Tarkista rajaukset ja kattavuus.",
            "SCENARIO_BLOCKED":"Menneen kulutuksen vaihtoehtolaskelma on estetty. Tarkista lähdehistoria, luokittelu ja pyydetty vähennys.",
            "PLAN_MISSING":"Tarkistettua suunnitelmaa ei ole saatavilla. Käytettävissä oleva määrä on tuntematon, ei nolla.",
            "PLAN_BLOCKED":"Tämä suunnitelma ei voi antaa ajantasaista käyttövaraa. Päivitä lähteet ja tarkista lähtötiedot.",
            "FACT_PROJECTION_NOT_IMPLEMENTED":"Käytä mukana olevia tyypitettyjä lähdetietoja. Tälle toiminnolle ei vielä ole tiivistettyjä talouslukuja.",
        },
        "unequal":"Jaksoissa on eri määrä kalenteripäiviä. Kokonaissummia ei ole suhteutettu kestoon.",
        "overlap":"Jaksot ovat päällekkäisiä ja sisältävät samoja kirjauksia. Ne eivät ole riippumattomia ennen–jälkeen-havaintoja.",
    },
    "sv": {
        "titles": ["Observerad konsumtion","Jämförelse av konsumtion","Historiskt alternativ","Granskad plan","Tjänstens underlag"],
        "summaries": [
            "Bokförda utgifter minus återbetalningar under den valda perioden. Detta beskriver tidigare poster, inte ett konsumtionsutrymme.",
            "Detta jämför observationer från två perioder enligt bokföringsdatum. Skillnaden är ingen prognos eller något konsumtionsutrymme.",
            "Detta är en hypotetisk minskning av tidigare kostnader. Inga transaktioner ändras och inga pengar flyttas.",
            "Konsumtion och sparande delar på det granskade överskottet. Beräkningen kan bli inaktuell; uppdatera den före ett beslut.",
            "Tjänstens fullständiga underlag finns bifogat. Ett kortfattat ekonomiskt svar finns ännu inte för denna funktion.",
        ],
        "statuses": {"ready":"Redo att granska","limited":"Begränsat underlag","blocked":"Granskning krävs"},
        "labels": ["Bokförda utgifter (brutto)","Bokförda återbetalningar","Observerad nettokonsumtion","Antal utgiftsposter","Antal återbetalningsposter",
            "Periodens början","Periodens slut (ingår inte)","Jämförelseperiodens nettokonsumtion","Den valda periodens nettokonsumtion",
            "Förändring i nettokonsumtion","Förändring i nettokonsumtion (%)","Hypotetisk kostnadsminskning","Nettokonsumtion efter hypotetisk ändring",
            "Granskat gemensamt överskott","Planens referenstidpunkt","Beräkningen gäller till","Begärt till (ingår inte)","Skyddad till"],
        "periods": {"current":"Vald period","baseline":"Jämförelseperiod"},
        "unavailable":"Inte tillgängligt", "minor":"valutans minsta enheter",
        "scope":"Värdena gäller endast kontona, filtren och tidpunkterna i det bifogade underlaget. De bekräftar inte hela ekonomin.",
        "reasons": {
            "INCOMPLETE_HISTORY":"Källhistoriken täcker inte hela det valda urvalet. Avsaknad av träffar bevisar inte att utgifter saknades.",
            "UNRESOLVED_FLOWS":"Vissa posters ekonomiska syfte är oklart. Granska deras klassificering.",
            "LIMITED_COMPARISON":"De observerade perioderna ger inte stöd för en förbehållslös jämförelse. Granska urvalet och täckningen.",
            "SCENARIO_BLOCKED":"Det historiska alternativet är blockerat. Granska källhistoriken, klassificeringen och den begärda minskningen.",
            "PLAN_MISSING":"Ingen granskad plan finns tillgänglig. Det tillgängliga beloppet är okänt, inte noll.",
            "PLAN_BLOCKED":"Denna plan kan inte ge ett aktuellt konsumtionsutrymme. Uppdatera källorna och granska uppgifterna.",
            "FACT_PROJECTION_NOT_IMPLEMENTED":"Använd det bifogade typade underlaget. Inga kortfattade ekonomiska fakta finns ännu för denna funktion.",
        },
        "unequal":"Perioderna har olika antal kalenderdagar. Totalsummorna har inte justerats för längden.",
        "overlap":"Perioderna överlappar och innehåller gemensamma poster. De är inte oberoende före- och efterobservationer.",
    },
}
MEANINGS=("gross_booked_expenses","booked_refunds","net_observed_spending","expense_count","refund_count",
    "window_start","window_end_exclusive","baseline_net_observed_spending","current_net_observed_spending",
    "net_observed_change","net_change_basis_points","hypothetical_cost_reduction","counterfactual_net_spending",
    "reviewed_shared_surplus","planning_observed_at","planning_expires_at","requested_until_exclusive","protected_through")
PRESENTATIONS=("observed_spending","spending_comparison","historical_scenario","reviewed_plan","tool_details")


def value_text(fact,locale,copy):
    value=fact.value
    if value is None: return copy["unavailable"]
    if fact.kind=="date": return value  # Preserve explicit ISO date/offset and exclusive-end semantics.
    if fact.kind=="count": return str(value)
    if fact.kind=="money" and fact.currency!="EUR":
        # No ISO currency-scale table is authorized here. Never guess JPY/KWD decimals.
        return f"{value} {copy['minor']} ({fact.currency})"
    whole,fraction=divmod(abs(value),100)
    integer=f"{whole:,}".replace(",","\u00a0") if locale!="en" else f"{whole:,}"
    number=f"{'-' if value<0 else ''}{integer}{'.' if locale=='en' else ','}{fraction:02d}"
    return number+(" EUR" if fact.kind=="money" else "%" if locale=="en" else "\u00a0%")


def render_answer(result,locale:AnswerLocale="en"):
    if locale not in COPY: raise AuthError("ANSWER_LOCALE_UNSUPPORTED",422)
    # Always ground the typed service artifact again, never trust caller-created
    # fact labels, formatted values, accepted claims or a cached presentation.
    answer=ground_answer(result)
    copy=COPY[locale];labels=dict(zip(MEANINGS,copy["labels"],strict=True))
    unknown=(result.name=="spending_totals" and result.result.expense_count==0 and result.result.refund_count==0
        and (result.result.unresolved_flow_count>0 or result.result.scope.dataset_coverage!="covered_synthetic_snapshot"))
    unestablished={"en":"Spending cannot be established from these records. Review unclassified entries and the selected scope.",
        "fi":"Kulutusta ei voi määrittää näistä tiedoista. Tarkista luokittelemattomat tapahtumat ja rajaus.",
        "sv":"Konsumtionen kan inte fastställas från dessa uppgifter. Granska oklassificerade poster och urvalet."}
    rows=[]
    for fact in answer.facts:
        label=labels[fact.meaning]
        if answer.presentation=="spending_comparison" and fact.meaning in ("window_start","window_end_exclusive"):
            label=copy["periods"][fact.fact_id.split(".")[0]]+": "+label
        rendered=copy["unavailable"] if unknown and fact.meaning in ("gross_booked_expenses","booked_refunds","net_observed_spending") else value_text(fact,locale,copy)
        rows.append(AnswerCardRowV1(fact_id=fact.fact_id,label=label,value_text=rendered))
    notices=[copy["scope"],*[copy["reasons"][reason] for reason in answer.reasons]]
    if answer.presentation=="spending_comparison":
        if not answer.artifact.result.equal_duration: notices.append(copy["unequal"])
        if answer.artifact.result.overlapping_windows: notices.append(copy["overlap"])
    index=PRESENTATIONS.index(answer.presentation)
    return AnswerCardV1(locale=locale,title=copy["titles"][index],summary=unestablished[locale] if unknown else copy["summaries"][index],
        status_label=copy["statuses"][answer.status],rows=rows,notices=notices,answer=answer)
