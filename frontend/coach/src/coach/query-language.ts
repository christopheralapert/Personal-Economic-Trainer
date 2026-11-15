/** Closed language forms only; quoted source labels and merchant text stay literal. */
export const categoryAliases:Record<string,string>={
  // Explicit spelling variants only; never fuzzy-match quoted source labels or merchants.
  "dinig out":"dining","dinning out":"dining",
  taxi:"taxi",taxis:"taxi",taksot:"taxi",takseihin:"taxi",taksimatkat:"taxi",takso:"taxi",taksole:"taxi",taksodele:"taxi",taksod:"taxi",taksosõidud:"taxi",taksosõite:"taxi",
  dining:"dining","dining out":"dining",ravintolat:"dining",ravintoloihin:"dining",ravintolakuluja:"dining","ulkona syöminen":"dining",restoranid:"dining",restoranidele:"dining",restoranikulusid:"dining","väljas söömine":"dining",
  coffee:"coffee",kahvi:"coffee",kahviin:"coffee",kahvikuluja:"coffee",kohv:"coffee",kohvile:"coffee",kohvikulusid:"coffee",
  groceries:"groceries",ruokaostokset:"groceries",ruokaostoksiin:"groceries",toidukaubad:"groceries",toidukaupadele:"groceries",
  housing:"housing",asuminen:"housing",asumiseen:"housing",eluasemekulud:"housing",eluasemele:"housing",
  repairs:"repairs",korjaukset:"repairs",korjauksiin:"repairs",remont:"repairs",remondile:"repairs",
  // Organizer dataset categories, with the localized labels shown in the app.
  transport:"transport","public transport":"transport",liikenne:"transport",liikenteeseen:"transport",joukkoliikenne:"transport",joukkoliikenteeseen:"transport",transpordile:"transport",ühistransport:"transport",ühistranspordile:"transport",
  travel:"travel",travelling:"travel",trips:"travel",matkailu:"travel",matkailuun:"travel",matkat:"travel",matkoihin:"travel",reisimine:"travel",reisimisele:"travel",reisid:"travel",reisidele:"travel",
  entertainment:"entertainment",viihde:"entertainment",viihteeseen:"entertainment",meelelahutus:"entertainment",meelelahutusele:"entertainment",
  utilities:"utilities","electricity and services":"utilities","sähkö ja palvelut":"utilities","sähköön ja palveluihin":"utilities",kommunaalkulud:"utilities",kommunaalkuludele:"utilities",
  health:"health",healthcare:"health",terveys:"health",terveyteen:"health",tervis:"health",tervisele:"health",
  lifestyle:"lifestyle",elämäntyyli:"lifestyle",elämäntyyliin:"lifestyle",elustiil:"lifestyle",elustiilile:"lifestyle",
  "home and technology":"home_tech","home tech":"home_tech",electronics:"home_tech","koti ja tekniikka":"home_tech","kotiin ja tekniikkaan":"home_tech","kodu ja tehnika":"home_tech","kodule ja tehnikale":"home_tech",
  investments:"investment",sijoitukset:"investment",sijoituksiin:"investment",investeeringud:"investment",investeeringutele:"investment",
};
const finnishMonths=["tammikuussa","helmikuussa","maaliskuussa","huhtikuussa","toukokuussa","kesäkuussa","heinäkuussa","elokuussa","syyskuussa","lokakuussa","marraskuussa","joulukuussa"];
const estonianMonths=["jaanuaris","veebruaris","märtsis","aprillis","mais","juunis","juulis","augustis","septembris","oktoobris","novembris","detsembris"];
export const localizedMonths:Record<string,number>=Object.fromEntries([finnishMonths,estonianMonths].flatMap(names=>names.map((name,index)=>[name,index])));

export function normalizeQueryPrefix(value:string):string {
  if(/^(?:muuta ajanjaksoa|muuda perioodi)$/iu.test(value))return "Change period";
  const spend=value.match(/^(?:(?:paljonko|kuinka paljon) (?:käytin|kulutin)|kui palju (?:kulutasin|maksin)) (.+)$/iu);
  if(spend) return `How much did I spend ${spend[1]}`;
  const list=value.match(/^(?:näytä (?:kulut|kulutukseni)|näita (?:kulutusi|kulusid))(?: (.+))?$/iu);
  if(list) return `Show spending${list[1] ? " "+list[1] : ""}`;
  const status=value.match(/^(?:näytä (kaikki|kirjatut|varatut|perutut) tapahtumat|näita (kõiki|kirjendatud|broneeritud|tühistatud) tehinguid)(.*)$/iu);
  if(status) {const selected=(status[1] ?? status[2]).toLowerCase();const labels:Record<string,string>={kaikki:"all",kirjatut:"booked",varatut:"reserved",perutut:"reversed",kõiki:"all",kirjendatud:"booked",broneeritud:"reserved",tühistatud:"reversed"};return `Show ${labels[selected]} transactions${status[3]}`;}
  const transactions=value.match(/^(?:näytä (?:tapahtumat|tilitapahtumat)|näita (?:tehinguid|tehingud))(?: (.+))?$/iu);
  if(transactions) return `Show transactions${transactions[1] ? " "+transactions[1] : ""}`;
  const reduction=value.match(/^(?:mitä jos vähennän|mis (?:siis, )?kui vähendan) (.+?) (\d{1,3}(?:[.,]\d{1,2})?)%(?: võrra)?(.*)$/iu);
  if(reduction) return `What if I cut ${reduction[1]} by ${reduction[2]}%${reduction[3]}`;
  const compare=value.match(/^vertaa (.+?) (?:kulutustani|kulujani) muihin(.*)$/iu) ?? value.match(/^võrdle (.+?) kulutusi teistega(.*)$/iu);
  if(compare) return `Compare my ${compare[1]} spending to others${compare[2]}`;
  return value;
}

/** Complete authored questions; additional clauses are never discarded. */
export const conceptRequests:Record<string,"fund"|"cashflow"|"habit"|"basketConcept"|"safeConcept"|"savingConcept"|"regular"|"irregular"|"everyday">=Object.fromEntries([
  ["fund",["explain emergency fund","selitä hätävara","selgita hädaabifondi"]],
  ["cashflow",["explain cash flow","what is cash flow","selitä kassavirta","selgita rahavoogu"]],
  ["habit",["explain a small change","selitä pieni muutos","selgita väikest muutust"]],
  ["savingConcept",["explain safe to save","explain a savings target","selitä lisäsäästäminen","selgita lisasäästu"]],
  ["basketConcept",["explain the three baskets","selitä kolme koria","selgita kolme korvi"]],
  ["safeConcept",["explain safe to spend","selitä turvallinen käyttövara","selgita turvalist kuluraha"]],
  ["regular",["explain mandatory and regular expenses","selitä pakolliset säännölliset menot","selgita regulaarseid vältimatuid kulusid"]],
  ["irregular",["explain mandatory and irregular expenses","selitä pakolliset epäsäännölliset menot","selgita ebaregulaarseid vältimatuid kulusid"]],
  ["everyday",["explain everyday spending","selitä arjen kulutus","selgita igapäevakulutusi"]],
].flatMap(([concept,questions])=>(questions as string[]).map(question=>[question,concept]))) as Record<string,"fund"|"cashflow"|"habit"|"basketConcept"|"safeConcept"|"savingConcept"|"regular"|"irregular"|"everyday">;
