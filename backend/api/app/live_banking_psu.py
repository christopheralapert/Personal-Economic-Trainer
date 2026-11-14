"""Ephemeral PSU context from the explicitly trusted loopback frontend only.

Never infer an online PSU for jobs. Browser-provided PSU/forwarded headers are
not accepted here; the frontend signs a short-lived request-bound envelope.
"""
import hashlib
import hmac
import ipaddress
import json
import time

from .identity import AuthError


def manual_psu(request):
    secret = request.app.state.settings.psu_proxy_secret
    if not secret:
        raise AuthError("BANK_PSU_CONTEXT_REQUIRED", 409)
    raw = request.headers.get("x-moneylens-psu-context", "")
    signature = request.headers.get("x-moneylens-psu-signature", "")
    if len(raw)>8192 or len(signature)!=64:
        raise AuthError("BANK_PSU_CONTEXT_REQUIRED",409)
    expected=hmac.new(secret.get_secret_value().encode(),raw.encode(),hashlib.sha256).hexdigest()
    try:
        peer=ipaddress.ip_address(request.client.host)
        data=json.loads(raw)
        valid=(peer.is_loopback and hmac.compare_digest(expected,signature)
            and data["method"]==request.method and data["path"]==request.url.path
            and data["session"]==request.headers.get("x-moneylens-session-id")
            and abs(time.time()-data["time"])<=30)
        headers=data["headers"]
        allowed={"Psu-Ip-Address","Psu-User-Agent","Psu-Accept","Psu-Accept-Language"}
        valid=valid and isinstance(headers,dict) and set(headers)<=allowed
        valid=valid and all(isinstance(v,str) and 0<len(v)<=2048 and not any(ord(c)<32 or ord(c)>126 for c in v) for v in headers.values())
        ipaddress.ip_address(headers["Psu-Ip-Address"])
        valid=valid and bool(headers.get("Psu-User-Agent"))
    except (ValueError,KeyError,TypeError,AttributeError):
        valid=False
    if not valid:
        raise AuthError("BANK_PSU_CONTEXT_REQUIRED",409)
    return headers
