import {createChatRoute} from "@/coach/chat-route";
import {createPublicCoachExecutor} from "@/coach/public-executor";
import {readPublicDataset} from '../demo-session-data';
export const maxDuration=15;
// Explicit public synthetic evaluation is independent of local/private AI grants.
// Privacy mode still exits before any model transport or accounting call.
export const POST=createChatRoute(createPublicCoachExecutor({readDataset:readPublicDataset}),readPublicDataset);
