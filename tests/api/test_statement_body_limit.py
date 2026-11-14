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


def test_both_preview_adapters_share_same_json_budget():
    for path in ('/v1/statements/preview','/v1/statements/wise/preview'):
        assert response_for(path,400000)==204
        assert response_for(path,400001)==413


def test_confirm_and_unrecognized_statement_commands_stay_small():
    for path in ('/v1/statements/confirm','/v1/statements/wise/confirm','/v1/statements/unknown'):
        assert response_for(path,8192)==204
        assert response_for(path,8193)==413
