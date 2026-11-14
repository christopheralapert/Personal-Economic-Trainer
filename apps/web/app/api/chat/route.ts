import {createChatRoute} from "@/coach/chat-route";
import {createCoachExecutor} from "@/coach/server-executor";
export const maxDuration=15;
// Public demo is offline by default. Optional local model evaluation still needs
// its expiring grant, paired origin and shared budget ledger. Private Coach's
// paid policy is deliberately not inherited by this public route.
const demoEnvironment=process.env.MONEY_COACH_LOCAL_AI_EVALUATION==="true"
 ? {...process.env,MONEYLENS_MODEL_BILLING_POLICY:"free_only"} : {};
export const POST=createChatRoute(createCoachExecutor({env:demoEnvironment}));
