import {defineConfig} from "vitest/config";
import {fileURLToPath} from "node:url";
import {coachRevision} from "./scripts/revision.mjs";
export default defineConfig({resolve:{alias:{"@":fileURLToPath(new URL("./src",import.meta.url)),"server-only":fileURLToPath(new URL("./node_modules/next/dist/compiled/server-only/empty.js",import.meta.url))}},test:{include:["src/**/*.test.ts"],environment:"node",env:{NEXT_PUBLIC_MONEY_COACH_REVISION:coachRevision()}}});
