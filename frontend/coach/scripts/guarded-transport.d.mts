import type {LiveBudget,UsageReceipt} from "./live-budget.mjs";
export const GEMINI_MODEL: "gemini-3.5-flash";
export const GEMINI_MAX_OUTPUT_TOKENS: 2048;
export function safeGeminiError(data:unknown):{code:string|null;hint:string|null;field:string|null};
export function createGuardedTransport(options:{budget:Pick<LiveBudget,"reserve"|"settle">;network?:typeof fetch;provider?:"openai"|"gemini";nonStreaming?:boolean}):{
  fetch:typeof fetch;
  settle(usage:UsageReceipt|null,reason:string):Promise<void>;
  snapshot():{fetches:number;httpStatus:number|null;reserved:boolean;settled:boolean;failure?:string|null;providerCode?:string|null;providerHint?:string|null;providerField?:string|null};
};
