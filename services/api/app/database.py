"""Scoped database boundary; no customer API routes use it before verified identity exists."""
from contextlib import contextmanager
from dataclasses import dataclass
from uuid import UUID

from psycopg import Connection
from psycopg.pq import TransactionStatus


@dataclass(frozen=True)
class TrustedScope:
    """Construct from server-verified membership only, never request/model arguments."""
    tenant_id: UUID
    user_id: UUID

    def __post_init__(self):
        if not isinstance(self.tenant_id, UUID) or not isinstance(self.user_id, UUID):
            raise TypeError("Trusted scope IDs must be UUID values")


@contextmanager
def tenant_transaction(connection: Connection, scope: TrustedScope, *, repeatable_read=False):
    if connection.info.transaction_status != TransactionStatus.IDLE:
        raise RuntimeError("Use a clean connection; nested or leaked transactions are rejected")
    with connection.transaction():
        if repeatable_read:
            connection.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
        connection.execute("SET LOCAL ROLE moneylens_runtime")
        connection.execute("SELECT set_config('app.tenant_id', %s, true)", (str(scope.tenant_id),))
        connection.execute("SELECT set_config('app.user_id', %s, true)", (str(scope.user_id),))
        yield connection
