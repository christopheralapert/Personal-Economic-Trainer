const currency=new Intl.NumberFormat("fi-FI",{style:"currency",currency:"EUR"});
/** Keep the last cent exact even near Number.MAX_SAFE_INTEGER. */
export const money=(minor:number)=>{
  if(!Number.isSafeInteger(minor)) throw new Error("Invalid minor-unit amount");
  const value=BigInt(minor),absolute=value<0n ? -value : value,whole=absolute/100n;
  const formatted=value<0n ? (whole===0n ? -0 : -whole) : whole;
  return currency.formatToParts(formatted).map(part=>part.type==="fraction" ? String(absolute%100n).padStart(2,"0") : part.type==="minusSign" ? "−" : part.value).join("");
};
export const signedMoney=(minor:number)=>(minor>0 ? "+" : "")+money(minor);
export const date=(iso:string)=>new Intl.DateTimeFormat("fi-FI",{timeZone:"Europe/Helsinki",day:"numeric",month:"numeric",year:"numeric"}).format(new Date(iso.length===10 ? iso+"T12:00:00Z" : iso));
export const percent=(n:number)=>new Intl.NumberFormat("fi-FI",{maximumFractionDigits:0,style:"percent"}).format(n/100);
export const precisePercent=(n:number)=>new Intl.NumberFormat("fi-FI",{maximumFractionDigits:2,style:"percent"}).format(n/100);
