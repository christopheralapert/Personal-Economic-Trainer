function collect(value:unknown,values:Set<number>):void {
  if(typeof value==="number"&&Number.isFinite(value)) {
    values.add(value);
    if(Number.isInteger(value)) values.add(value/100);
    return;
  }
  if(typeof value==="string") {
    for(const match of value.matchAll(/\d+(?:[\u00a0\u202f ]\d{3})*(?:[.,]\d+)?/g)) values.add(Number(match[0].replace(/[\u00a0\u202f ]/g,"").replace(",",".")));
    return;
  }
  if(Array.isArray(value)) {
    values.add(value.length);
    for(const item of value) collect(item,values);
    for(const key of ["amount","amount_minor","netExpenses","expenses","monthly","annual"]) {
      const total=value.reduce((sum,item)=>{
        if(item&&typeof item==="object"&&typeof (item as Record<string,unknown>)[key]==="number") return sum+(item as Record<string,number>)[key];
        return sum;
      },0);
      if(total) {values.add(total);if(Number.isInteger(total)) values.add(total/100);}
    }
    return;
  }
  if(value&&typeof value==="object") for(const item of Object.values(value)) collect(item,values);
}

/** Rejects model-authored numeric claims unless the validated tool output contains them. */
export function hasOnlyGroundedNumbers(text:string,toolOutput:unknown):boolean {
  const allowed=new Set<number>();collect(toolOutput,allowed);
  return [...text.matchAll(/\d+(?:[\u00a0\u202f ]\d{3})*(?:[.,]\d+)?/g)].every(match=>allowed.has(Number(match[0].replace(/[\u00a0\u202f ]/g,"").replace(",","."))));
}
