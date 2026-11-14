export function MoneyAmount({minor}:{minor:number}) {
  const parts=new Intl.NumberFormat("fi-FI",{style:"currency",currency:"EUR"}).formatToParts(minor/100);
  return <span className="tabular-nums">{parts.map((part,index)=>part.type==="currency" ? <span className="text-caption" key={index}>{part.value}</span> : <span key={index}>{part.value.replace(/-/g,"−")}</span>)}</span>;
}
