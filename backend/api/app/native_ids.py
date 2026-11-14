"""Stable scoped native identities; references never confer access authority."""
import hashlib
from uuid import UUID

from .planning_store import fingerprint


def native_id(parent,kind,reference):
    if not isinstance(parent,UUID) or kind not in ("feed","account","transaction","balance"):
        raise ValueError("Use a registered native identity namespace")
    return UUID(bytes=hashlib.sha256(f"moneylens.import.{kind}.v1:{parent}:{reference}".encode("utf-8")).digest()[:16])


def feed_identity(scope,manifest):
    digest=fingerprint({"tenant":str(scope.tenant_id),"mapping":manifest.mapping_version,
        "customer":manifest.source_customer_ref,"currency":manifest.currency})
    return native_id(scope.user_id,"feed",digest),digest
