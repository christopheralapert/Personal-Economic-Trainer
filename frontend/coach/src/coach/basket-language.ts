import {basketSchema,type Basket} from "@/engine";
import {dictionaries} from "@/i18n/dictionaries";

const labels={mandatory_regular:"regular",mandatory_irregular:"irregular",everyday:"everyday",unresolved:"unresolved"} as const;
const aliases=new Map<string,Basket>();
for(const [basket,key] of Object.entries(labels)) for(const copy of Object.values(dictionaries)) {
  const label=copy[key].toLowerCase();aliases.set(label,basket as Basket);
  aliases.set(label.replace("&","and"),basket as Basket);
}
/** Exactly one closed basket name or quoted identifier; never consume a trailing clause. */
export function basketSelector(text:string):Basket|null {
  const literal=text.match(/^(?:in )?(?:basket|korissa|korvis) ("(?:[^"\\]|\\.)*")$/iu);
  if(literal) {try {const parsed=basketSchema.safeParse(JSON.parse(literal[1]));return parsed.success ? parsed.data : null;} catch {return null;}}
  return aliases.get(text.toLowerCase()) ?? null;
}
