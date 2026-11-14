# syntax=docker/dockerfile:1
FROM python:3.12.16-slim-bookworm@sha256:935c3c5b12357a7e10caa9c1e6ca5692344d97cf229832ef584be2cec9fc03df AS dependencies
ENV PIP_DISABLE_PIP_VERSION_CHECK=1 PIP_NO_CACHE_DIR=1
WORKDIR /build
COPY backend/api/requirements.txt ./requirements.txt
RUN python -m venv /opt/venv && /opt/venv/bin/pip install --only-binary=:all: -r requirements.txt

FROM python:3.12.16-slim-bookworm@sha256:935c3c5b12357a7e10caa9c1e6ca5692344d97cf229832ef584be2cec9fc03df AS runtime
ENV PATH=/opt/venv/bin:$PATH PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PYTHONPATH=/app/backend/api
WORKDIR /app
RUN groupadd --gid 10001 moneylens && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin moneylens
COPY --from=dependencies /opt/venv /opt/venv
COPY backend/api/app backend/api/app
COPY fixtures/public fixtures/public
COPY fixtures/synthetic/demo.v1.json fixtures/synthetic/demo.v1.json
USER 10001:10001

FROM runtime AS api
EXPOSE 8000
HEALTHCHECK --interval=15s --timeout=4s --start-period=20s --retries=4 CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health/ready',timeout=3).close()"]
CMD ["python", "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--no-access-log", "--no-proxy-headers"]

# Workers never default to a global or invented owner. Supply verified UUIDs.
FROM runtime AS worker
COPY backend/workers/run.py backend/workers/run.py
ENTRYPOINT ["python", "backend/workers/run.py"]

# A separate one-shot image; administrative credentials never reach the API.
FROM runtime AS migration
COPY backend/db/alembic.ini backend/db/alembic.ini
COPY backend/db/migrations backend/db/migrations
ENTRYPOINT ["python", "-m", "alembic", "-c", "backend/db/alembic.ini"]
CMD ["current"]
