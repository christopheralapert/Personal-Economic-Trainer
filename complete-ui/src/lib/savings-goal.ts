export type SavingsGoal={name:string;amountMinor:number};

/** Decimal input is converted directly to cents, never through floating point. */
export function goalAmountMinor(input:string):number|null {
  const value=input.trim();
  if(!/^\d{1,16}(?:[.,]\d{1,2})?$/.test(value)) return null;
  const [whole,fraction=""]=value.split(/[.,]/);
  const cents=BigInt(whole)*100n+BigInt(fraction.padEnd(2,"0"));
  return cents>0n && cents<=BigInt(Number.MAX_SAFE_INTEGER) ? Number(cents) : null;
}
export function goalAmountInput(minor:number):string {
  if(!Number.isSafeInteger(minor) || minor<=0) throw new Error("Invalid goal amount");
  const value=BigInt(minor);
  return `${value/100n},${String(value%100n).padStart(2,"0")}`;
}
