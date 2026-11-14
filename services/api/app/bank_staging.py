"""Purpose-separated integrity seal for owned, completed source checkpoints."""
import hashlib
import hmac
import json

from .bank_adapter import BankError
from .identity import derive


def seal_stage(secret,scope,connection_id,checkpoint):
    key=derive(secret,"bank.stage.v1",f"{scope.tenant_id}:{scope.user_id}:{connection_id}").encode()
    body=json.dumps({key:value for key,value in checkpoint.items() if key!="seal"},sort_keys=True,
        ensure_ascii=True,separators=(",",":"),allow_nan=False).encode()
    return hmac.new(key,body,hashlib.sha256).hexdigest()


def verify_stage(secret,scope,connection_id,checkpoint):
    seal=checkpoint.get("seal")
    if not isinstance(seal,str) or len(seal)!=64 or not seal.isascii() or not hmac.compare_digest(
        seal,seal_stage(secret,scope,connection_id,checkpoint)):
        raise BankError("source_stage_integrity_failed")
