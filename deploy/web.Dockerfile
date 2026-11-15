# syntax=docker/dockerfile:1
FROM node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df AS build
WORKDIR /build
ENV NEXT_TELEMETRY_DISABLED=1 MONEYLENS_STANDALONE=true
COPY package.json package-lock.json ./
COPY frontend/web/package.json frontend/web/package.json
COPY frontend/coach/package.json frontend/coach/package.json
RUN npm ci --workspace @moneylens/web --workspace @moneylens/coach --include-workspace-root --no-audit --no-fund
COPY frontend/web frontend/web
COPY frontend/coach/src frontend/coach/src
COPY frontend/coach/data frontend/coach/data
COPY frontend/coach/scripts frontend/coach/scripts
COPY frontend/coach/postcss.config.mjs frontend/coach/postcss.config.mjs
COPY packages/contracts/api.d.ts packages/contracts/api.d.ts
COPY scripts/generate_pwa.mjs scripts/generate_pwa.mjs
COPY scripts/web_revision.mjs scripts/web_revision.mjs
RUN npm run build:web

FROM node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df AS web
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000
WORKDIR /app
COPY --from=build --chown=node:node /build/frontend/web/.next/standalone ./
COPY --from=build --chown=node:node /build/frontend/web/.next/static ./frontend/web/.next/static
COPY --from=build --chown=node:node /build/frontend/web/public ./frontend/web/public
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=4s --start-period=20s --retries=4 CMD ["node", "-e", "fetch('http://127.0.0.1:3000/offline',{signal:AbortSignal.timeout(3000)}).then(r=>process.exit(r.status===200?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "frontend/web/server.js"]
