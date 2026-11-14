# Local infrastructure and containers

Run commands from the repository root.

`compose.yaml` provides PostgreSQL and object storage for configured local development:

```sh
npm run infra:up
npm run infra:check
npm run infra:down
```

Stopping infrastructure does not delete the named database or storage volumes. The development configuration uses fixed local-only credentials and loopback port bindings; do not deploy it publicly.

`compose.local.yaml` provides a separate synthetic application preview using `api.Dockerfile` and `web.Dockerfile`. It does not load the root `.env`, connect to the development database, or enable paid model calls:

```sh
docker compose -f deploy/compose.local.yaml up --build -d
npm run test:web:container
docker compose -f deploy/compose.local.yaml down
```

Open the preview at http://127.0.0.1:33110. Docker builds use the repository root as their context and the root `.dockerignore` allowlist. The API Dockerfile also defines scoped worker and one-shot migration targets; migrations use `backend/db/alembic.ini` and require explicit administrative configuration.
