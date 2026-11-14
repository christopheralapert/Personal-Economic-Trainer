export const MODEL:"gpt-4.1-mini";
export const DAILY_TOKENS:number;
export const MAX_COST_MICRO_EUR:number;
export const MAX_INPUT_TOKENS:number;
export const MAX_OUTPUT_TOKENS:number;
export const REQUEST_COST_MICRO_EUR:number;
export const REQUEST_RESERVATION:number;
export const MAX_ATTEMPTS:number;
export const liveDirectory:string;
export function costMicroEUR(input:number,output:number):number;
export function keyFingerprint(key:string):string;
export type UsageReceipt={inputTokens:number|null;outputTokens:number|null;totalTokens:number|null};
export interface LiveBudget {
  reserve():Promise<string>;
  settle(id:string,usage:UsageReceipt|null,reason:string):Promise<void>;
  halt(reason:string):Promise<void>;
  summary():{model:string;attempts:number;countedTokens:number;dailyTokens:number;countedCostMicroEUR:number;maximumCostMicroEUR:number;expiresAt:string;halted:string|null};
  close(options?:{retainLock?:boolean}):Promise<void>;
}
export function openBudget(options?:{directory?:string;key?:string;now?:()=>Date;requiredOrigin?:string;requiredRevision?:string}):Promise<LiveBudget>;
