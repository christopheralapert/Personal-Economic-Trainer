"""Opaque server sessions: only hashes persist; identity never comes from request IDs."""
import base64
from dataclasses import dataclass, field
from contextlib import contextmanager
from datetime import datetime
import hashlib
import hmac
import secrets
from uuid import UUID, uuid4

from psycopg.rows import dict_row
from psycopg.errors import SerializationFailure

from .database import TrustedScope, tenant_transaction

DEMO_ISSUER = "urn:moneylens:synthetic"
DEMO_SUBJECTS = {"aino":"aino.v1", "mika":"mika.v1"}


class AuthError(Exception):
    def __init__(self, code="UNAUTHENTICATED", status=401):
        self.code, self.status = code, status


def digest(token):
    return hashlib.sha256(token.encode()).hexdigest()


def derive(secret, purpose, token):
    return base64.urlsafe_b64encode(hmac.digest(secret.encode(), (purpose+":"+token).encode(), "sha256")).decode().rstrip("=")


@dataclass(frozen=True)
class Principal:
    scope: TrustedScope
    session_id: UUID
    permission_version: int
    expires_at: datetime
    display_name: str
    synthetic: bool
    token: str = field(repr=False)


@contextmanager
def authorized_transaction(connection, user, *, repeatable_read=False, write=False):
    try:
        with tenant_transaction(connection,user.scope,repeatable_read=repeatable_read):
            # Lock the owned state before inspecting membership. A database trigger
            # modifies this row when access changes, including under repeatable read.
            lock = "UPDATE" if write else "SHARE"
            state = connection.execute("SELECT id FROM moneylens.user_state WHERE tenant_id=%s AND owner_user_id=%s FOR "+lock,
                (user.scope.tenant_id,user.scope.user_id)).fetchone()
            if state is None:
                raise AuthError("DATASET_STATE_UNAVAILABLE",409)
            row = connection.execute("SELECT active,permission_version FROM moneylens.users WHERE tenant_id=%s AND id=%s",
                (user.scope.tenant_id,user.scope.user_id)).fetchone()
            if row != (True,user.permission_version):
                raise AuthError()
            yield connection
    except SerializationFailure:
        raise AuthError("DATA_CHANGED_RETRY",409) from None


class Identity:
    def __init__(self, pools, settings):
        self.pools, self.settings = pools, settings
        self.secret = settings.session_secret.get_secret_value()

    @staticmethod
    def cleanup(connection):
        for table,key in (("sessions","token_hash"),("login_states","state_hash")):
            # Constant repository identifiers; skip other replicas' cleanup locks.
            connection.execute(f"""WITH expired AS (SELECT {key} FROM moneylens_identity.{table}
                WHERE expires_at<statement_timestamp() FOR UPDATE SKIP LOCKED LIMIT 100)
                DELETE FROM moneylens_identity.{table} target USING expired WHERE target.{key}=expired.{key}""")

    def login(self, issuer, subject, *, synthetic=False, previous=None):
        if issuer == DEMO_ISSUER and (not synthetic or not self.settings.allow_demo):
            raise AuthError("SYNTHETIC_LOGIN_DISABLED",403)
        with self.pools.identity() as connection, connection.cursor(row_factory=dict_row) as cursor:
            rows = cursor.execute("""SELECT tenant_id,id,permission_version,active,is_synthetic FROM moneylens.users
                WHERE subject_issuer=%s AND subject_id=%s LIMIT 2""", (issuer,subject)).fetchall()
            if len(rows) != 1 or not rows[0]["active"] or rows[0]["is_synthetic"] != synthetic:
                raise AuthError("MEMBERSHIP_UNAVAILABLE",403)
            row = rows[0]
            if previous:
                cursor.execute("UPDATE moneylens_identity.sessions SET revoked_at=clock_timestamp() WHERE token_hash=%s",(digest(previous),))
            token = secrets.token_urlsafe(32)
            cursor.execute("""INSERT INTO moneylens_identity.sessions
                (token_hash,id,tenant_id,user_id,permission_version,expires_at)
                VALUES (%s,%s,%s,%s,%s,clock_timestamp()+(%s*interval '1 second'))""",
                (digest(token),uuid4(),row["tenant_id"],row["id"],row["permission_version"],self.settings.session_seconds))
            # Bounded opportunistic cleanup, shared safely by all API replicas.
            self.cleanup(connection)
        return token

    def resolve(self, token):
        if not token or len(token) > 128:
            raise AuthError()
        with self.pools.identity() as connection, connection.cursor(row_factory=dict_row) as cursor:
            row = cursor.execute("""UPDATE moneylens_identity.sessions s SET last_seen_at=clock_timestamp()
                FROM moneylens.users u WHERE s.token_hash=%s AND s.tenant_id=u.tenant_id AND s.user_id=u.id
                AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
                AND s.last_seen_at>clock_timestamp()-(%s*interval '1 second')
                AND u.active AND u.permission_version=s.permission_version
                RETURNING s.id,s.tenant_id,s.user_id,s.permission_version,s.expires_at,u.display_name,u.is_synthetic""",
                (digest(token),self.settings.session_idle_seconds)).fetchone()
        if not row:
            raise AuthError()
        return Principal(TrustedScope(row["tenant_id"],row["user_id"]),row["id"],row["permission_version"],row["expires_at"],row["display_name"],row["is_synthetic"],token)

    def csrf(self, token):
        return derive(self.secret,"csrf.v1",token)

    def revoke(self, token):
        with self.pools.identity() as connection:
            connection.execute("UPDATE moneylens_identity.sessions SET revoked_at=clock_timestamp() WHERE token_hash=%s",(digest(token),))

    def begin_login(self, binding):
        state = secrets.token_urlsafe(32)
        with self.pools.identity() as connection:
            self.cleanup(connection)
            connection.execute("""INSERT INTO moneylens_identity.login_states (state_hash,binding_hash,issuer,client_id,expires_at)
                VALUES (%s,%s,%s,%s,clock_timestamp()+interval '10 minutes')""",
                (digest(state),digest(binding),self.settings.oidc_issuer,self.settings.oidc_client_id))
        return state

    def consume_login(self, state, binding):
        if not state or not binding or len(state)>128 or len(binding)>128:
            raise AuthError("INVALID_LOGIN_STATE",400)
        with self.pools.identity() as connection:
            row = connection.execute("""DELETE FROM moneylens_identity.login_states
                WHERE state_hash=%s AND binding_hash=%s AND issuer=%s AND client_id=%s AND expires_at>clock_timestamp()
                RETURNING state_hash""",(digest(state),digest(binding),self.settings.oidc_issuer,self.settings.oidc_client_id)).fetchone()
        if not row:
            raise AuthError("INVALID_LOGIN_STATE",400)
