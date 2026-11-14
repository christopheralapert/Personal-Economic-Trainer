"""Bound planning command bodies before JSON parsing, including direct API access."""
from starlette.responses import JSONResponse


class PlanningBodyLimit:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        path = scope.get("path", "")
        bounded = path.startswith("/v1/statements/") or path == "/v1/imports" or path.startswith("/v1/imports/") or path == "/v1/plans" or path.startswith("/v1/plans/") or path == "/v1/bank-connections" or path.startswith("/v1/bank-connections/") or path.startswith("/v1/benchmarks/") or path == "/v1/goals" or path.startswith("/v1/goals/") or path.startswith("/v1/insights/") or path == "/v1/coaching/preferences" or path in ("/v1/analysis/tools/execute","/v1/analysis/spending/reduction")
        bounded = bounded or path.startswith("/v1/ledger/transactions/") or path.startswith("/v1/accounts/") or path.startswith("/v1/live-banking/") or path in ("/v2/analysis/tools/execute","/v2/analysis/tools/answer","/v2/analysis/tools/answer/card","/v1/analysis/spending/habits","/v1/coach/query")
        if scope["type"] != "http" or scope["method"] != "POST" or not bounded:
            await self.app(scope, receive, send)
            return
        limit = 400000 if path in ("/v1/statements/wise/preview","/v1/statements/preview") else 65536 if path == "/v1/plans" else 8192
        chunks, size = [], 0
        while True:
            message = await receive()
            if message["type"] == "http.disconnect":
                return
            chunk = message.get("body", b"")
            size += len(chunk)
            if size > limit:
                response = JSONResponse(status_code=413, content={"error": {"code": "REQUEST_TOO_LARGE",
                    "message": "Use a smaller command."}})
                await response(scope, receive, send)
                return
            chunks.append(chunk)
            if not message.get("more_body", False):
                break
        delivered = False
        async def replay():
            nonlocal delivered
            if not delivered:
                delivered = True
                return {"type": "http.request", "body": b"".join(chunks), "more_body": False}
            return await receive()
        await self.app(scope, replay, send)
