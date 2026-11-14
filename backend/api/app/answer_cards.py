"""Localized templates over freshly grounded facts; no model-written prose."""
from datetime import timedelta
from types import SimpleNamespace
from typing import Annotated,Literal

from pydantic import Field

from .answer_grounding import GroundedAnswerV1,ground_answer
from .contracts import Contract
from .identity import AuthError

AnswerLocale=Literal["en","fi","sv","et"]
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
    "et": {
        "titles":["Vaadeldud kulutused","Kulutuste võrdlus","Ajalooline oletus","Ülevaadatud plaan","Teenuse tõendid"],
        "summaries":[
            "Kirjendatud kulud miinus tagasimaksed valitud perioodil. See kirjeldab varasemaid tehinguid ega määra kuluraha.",
            "Võrdlus kasutab kahe perioodi kirjendamiskuupäevi. Erinevus ei ole prognoos ega kuluraha.",
            "See on varasemate kulude oletuslik vähendamine. Tehinguid ei muudeta ja raha ei liigutata.",
            "Kulutamine ja säästmine jagavad sama ülevaadatud ülejääki. Arvutus võib aeguda; uuenda seda enne otsustamist.",
            "Teenuse täielikud tõendid on lisatud. Selle toimingu jaoks puudub veel lühike rahaline vastus.",
        ],
        "statuses":{"ready":"Valmis vaatamiseks","limited":"Piiratud tõendid","blocked":"Vajab ülevaatust"},
        "labels":["Kirjendatud kulud","Kirjendatud tagasimaksed","Vaadeldud netokulutused","Kulutehingute arv","Tagasimaksete arv",
            "Perioodi algus","Perioodi lõpp (välja arvatud)","Võrdlusperioodi netokulutused","Valitud perioodi netokulutused",
            "Netokulutuste muutus","Netokulutuste muutus (%)","Oletuslik kulude vähendus","Netokulutused oletusliku muutuse järel",
            "Ülevaadatud ühine ülejääk","Plaani vaatlushetk","Arvutuse aegumine","Soovitud perioodi lõpp (välja arvatud)","Kaitstud kuni"],
        "periods":{"current":"Valitud periood","baseline":"Võrdlusperiood"},
        "unavailable":"Teadmata","minor":"valuuta väikseimat ühikut",
        "scope":"Arvud kehtivad ainult lisatud tõendite kontode, filtrite ja kuupäevade kohta. Need ei kinnita kogu rahalist olukorda.",
        "reasons":{
            "INCOMPLETE_HISTORY":"Allikate ajalugu ei kata kogu valitud perioodi. Vastete puudumine ei tõesta kulutuste puudumist.",
            "UNRESOLVED_FLOWS":"Mõne tehingu majanduslik eesmärk on teadmata. Vaata nende liigitus üle.",
            "LIMITED_COMPARISON":"Vaadeldud perioodid ei võimalda tingimusteta kulutuste võrdlust. Kontrolli ulatust ja kaetust.",
            "SCENARIO_BLOCKED":"Ajaloolist oletust ei saa arvutada. Kontrolli allikaid, liigitust ja soovitud vähendust.",
            "PLAN_MISSING":"Ülevaadatud plaan puudub. Kasutatav summa on teadmata, mitte null.",
            "PLAN_BLOCKED":"See plaan ei anna ajakohast kuluraha. Uuenda allikaid ja vaata sisendid üle.",
            "FACT_PROJECTION_NOT_IMPLEMENTED":"Kasuta lisatud tüübitud tõendeid; selle toimingu jaoks puuduvad veel kokkuvõtlikud rahalised faktid.",
        },
        "unequal":"Perioodides on erinev arv kalendripäevi. Kogusummasid ei ole kestuse järgi kohandatud.",
        "overlap":"Perioodid kattuvad ja sisaldavad samu tehinguid. Need ei ole sõltumatud enne ja pärast vaatlused.",
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


def money_text(amount,currency,locale):
    return value_text(SimpleNamespace(value=amount,kind="money",currency=currency),locale,COPY[locale])


def period_text(scope):
    return str(scope.start),str(scope.end_exclusive-timedelta(days=1))


def transaction_sentence(page,locale):
    start,end=period_text(page.scope);count=len(page.rows)
    amount=money_text(sum(row.amount_minor for row in page.rows),page.scope.currency,locale)
    # A bounded search page contains all flows. Its signed cash movement is never spending.
    return {
        "en":f"This page shows {count} booked transactions from {start} through {end}, with a net cash movement of {amount}. This page is not a spending total; the attached records include unresolved flows and may continue on another page.",
        "fi":f"Tällä sivulla on {count} kirjattua tapahtumaa ajalta {start}–{end}, ja niiden nettorahavirta on {amount}. Tämä ei ole kulutuksen kokonaissumma; mukana voi olla selvittämättömiä rahavirtoja ja tapahtumat voivat jatkua seuraavalla sivulla.",
        "et":f"Sellel lehel on {count} kirjendatud tehingut ajavahemikus {start}–{end}, netorahavooga {amount}. See ei ole kulutuste kogusumma; lisatud tehingud võivad sisaldada teadmata rahavooge ja jätkuda järgmisel lehel.",
        "sv":f"Denna sida visar {count} bokförda transaktioner från {start} till och med {end}, med ett nettokassaflöde på {amount}. Detta är ingen konsumtionssumma; posterna kan ha oklart syfte och fortsätta på nästa sida.",
    }[locale]


def answer_sentence(answer,locale,*,unknown=False):
    copy=COPY[locale];result=answer.artifact.result
    facts={fact.fact_id:value_text(fact,locale,copy) for fact in answer.facts}
    if answer.presentation=="observed_spending":
        start,end=period_text(result.scope)
        if unknown:
            return {
                "en":f"Spending cannot be established from these records for {start} through {end}; the amount is unknown, not zero. Review unclassified entries and the selected scope.",
                "fi":f"Kulutusta ei voi määrittää näistä tiedoista ajalta {start}–{end}; summa on tuntematon, ei nolla. Tarkista luokittelemattomat tapahtumat ja rajaus.",
                "et":f"Kulutusi ei saa nende andmete põhjal ajavahemikus {start}–{end} määrata; summa on teadmata, mitte null. Vaata liigitamata tehingud ja valitud ulatus üle.",
                "sv":f"Konsumtionen kan inte fastställas från dessa uppgifter för {start} till och med {end}; beloppet är okänt, inte noll. Granska oklassificerade poster och urvalet.",
            }[locale]
        amount=facts["net_minor"]
        sentence={"en":f"Recorded net spending was {amount} from {start} through {end}.",
            "fi":f"Kirjattu nettokulutus oli {amount} ajalta {start}–{end}.",
            "et":f"Kirjendatud netokulutused olid {amount} ajavahemikus {start}–{end}.",
            "sv":f"Bokförd nettokonsumtion var {amount} från {start} till och med {end}."}[locale]
    elif answer.presentation=="spending_comparison":
        start,end=period_text(result.current.scope);first,last=period_text(result.baseline.scope)
        amount,before,delta=(facts[key] for key in ("current.net_minor","baseline.net_minor","change.net_minor"))
        sentence={"en":f"Recorded net spending was {amount} from {start} through {end}, compared with {before} from {first} through {last}; the observed change was {delta}.",
            "fi":f"Kirjattu nettokulutus oli {amount} ajalta {start}–{end} ja {before} ajalta {first}–{last}; havaittu muutos oli {delta}.",
            "et":f"Kirjendatud netokulutused olid {amount} ajavahemikus {start}–{end} ja {before} ajavahemikus {first}–{last}; vaadeldud muutus oli {delta}.",
            "sv":f"Bokförd nettokonsumtion var {amount} från {start} till och med {end}, jämfört med {before} från {first} till och med {last}; förändringen var {delta}."}[locale]
    elif answer.presentation=="historical_scenario":
        start,end=period_text(result.baseline.scope)
        amount=facts["reduction.amount_minor"];remaining=facts["counterfactual.net_minor"]
        if answer.status=="blocked":
            return {"en":f"The hypothetical reduction for {start} through {end} is unknown; review the attached source coverage, classification and reduction before calculating an amount.",
                "fi":f"Oletettu vähennys ajalta {start}–{end} on tuntematon; tarkista lähteiden kattavuus, luokittelu ja vähennys ennen summan laskemista.",
                "et":f"Oletuslik vähendus ajavahemikus {start}–{end} on teadmata; kontrolli enne summa arvutamist allikate kaetust, liigitust ja vähendust.",
                "sv":f"Den hypotetiska minskningen för {start} till och med {end} är okänd; granska källtäckning, klassificering och minskning före beräkning."}[locale]
        sentence={"en":f"The hypothetical cost reduction for {start} through {end} is {amount}, leaving {remaining} in historical net spending.",
            "fi":f"Oletettu kulujen vähennys ajalta {start}–{end} on {amount}, jolloin menneeksi nettokulutukseksi jää {remaining}.",
            "et":f"Oletuslik kulude vähendus ajavahemikus {start}–{end} on {amount}, jättes varasemaks netokulutuseks {remaining}.",
            "sv":f"Den hypotetiska kostnadsminskningen för {start} till och med {end} är {amount}, med {remaining} kvar i historisk nettokonsumtion."}[locale]
    elif answer.presentation=="reviewed_plan" and answer.status=="blocked":
        return copy["reasons"]["PLAN_MISSING" if result.plan is None else "PLAN_BLOCKED"]
    else: return copy["summaries"][PRESENTATIONS.index(answer.presentation)]
    return sentence+" "+copy["summaries"][PRESENTATIONS.index(answer.presentation)]


def render_answer(result,locale:AnswerLocale="en"):
    if locale not in COPY: raise AuthError("ANSWER_LOCALE_UNSUPPORTED",422)
    # Always ground the typed service artifact again, never trust caller-created
    # fact labels, formatted values, accepted claims or a cached presentation.
    answer=ground_answer(result)
    copy=COPY[locale];labels=dict(zip(MEANINGS,copy["labels"],strict=True))
    unknown=(result.name=="spending_totals" and result.result.expense_count==0 and result.result.refund_count==0
        and (result.result.unresolved_flow_count>0 or result.result.scope.dataset_coverage!="covered_synthetic_snapshot"))
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
    return AnswerCardV1(locale=locale,title=copy["titles"][index],summary=answer_sentence(answer,locale,unknown=unknown),
        status_label=copy["statuses"][answer.status],rows=rows,notices=notices,answer=answer)
