"""Direct/BFF preview routes allow bounded CSV JSON, never unbounded uploads."""
import asyncio
from app.request_limits import PlanningBodyLimit


def response_for(path,size):
    messages=[]
    delivered=False
    async def app(scope,receive,send):
        await receive()
        await send(dict(type='http.response.start',status=204,headers=[]))
        await send(dict(type='http.response.body',body=b''))
    async def receive():
        nonlocal delivered
        if delivered:return dict(type='http.disconnect')
        delivered=True
        return dict(type='http.request',body=b'x'*size,more_body=False)
    async def send(message):messages.append(message)
    asyncio.run(PlanningBodyLimit(app)(dict(type='http',method='POST',path=path),receive,send))
    return messages[0]['status']


def test_preview_budgets_bound_each_supported_upload_contract():
    for path,limit in (('/v1/statements/preview',400000),('/v1/statements/wise/preview',2800000)):
        assert response_for(path,limit)==204
        assert response_for(path,limit+1)==413


def test_confirm_and_unrecognized_statement_commands_stay_small():
    for path in ('/v1/statements/confirm','/v1/statements/wise/confirm','/v1/statements/unknown'):
        assert response_for(path,8192)==204
        assert response_for(path,8193)==413
