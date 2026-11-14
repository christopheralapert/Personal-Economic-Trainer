"""Versioned keys and signed cursors bind transient state to verified financial scope."""
from dataclasses import dataclass
import hashlib
import hmac
import json
import re
import time
from uuid import UUID

from cryptography.fernet import Fernet, InvalidToken

from .database import TrustedScope
from .identity import AuthError, derive


@dataclass(frozen=True)
class DataScope:
    owner: TrustedScope
    permission_version: int
    data_version: int
    plan_version: int
    account_ids: tuple[UUID,...]
    currency: str
    filters: dict

    def key(self,namespace):
        body = {"version":1,"namespace":namespace,"tenant":str(self.owner.tenant_id),"user":str(self.owner.user_id),
            "permission_version":self.permission_version,"data_version":self.data_version,"plan_version":self.plan_version,
            "accounts":sorted(str(value) for value in self.account_ids),"currency":self.currency,"filters":self.filters}
        return hashlib.sha256(json.dumps(body,sort_keys=True,separators=(",",":")).encode()).hexdigest()


class CursorCodec:
    def __init__(self,secret,clock=time.time):
        self.cipher = Fernet((derive(secret,"cursor.signing-key.v1","")+"=").encode())
        self.clock = clock

    def encode(self,scope,position,*,namespace="ledger.page.v1"):
        payload = {"version":1,"scope":scope.key(namespace),"position":position,"expires":int(self.clock())+900}
        return "v1."+self.cipher.encrypt_at_time(json.dumps(payload,sort_keys=True,separators=(",",":")).encode(),int(self.clock())).decode()

    def decode(self,token,scope,*,namespace="ledger.page.v1"):
        if not isinstance(token,str) or len(token)>4096 or not re.fullmatch(r"v1\.[A-Za-z0-9_-]+={0,2}",token):
            raise AuthError("INVALID_CURSOR",400)
        try:
            payload = json.loads(self.cipher.decrypt(token[3:].encode()))
            if set(payload)!={"version","scope","position","expires"} or type(payload["version"]) is not int or payload["version"]!=1 or type(payload["expires"]) is not int:
                raise ValueError()
            if payload["expires"]<=self.clock():
                raise AuthError("CURSOR_EXPIRED",409)
            if not hmac.compare_digest(payload["scope"],scope.key(namespace)):
                raise AuthError("CURSOR_SCOPE_CHANGED",409)
            if not isinstance(payload["position"],dict):
                raise ValueError()
            return payload["position"]
        except (InvalidToken,ValueError,TypeError,KeyError):
            raise AuthError("INVALID_CURSOR",400) from None
