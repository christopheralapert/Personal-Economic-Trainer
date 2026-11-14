from functools import lru_cache
from typing import Literal
from urllib.parse import urlsplit

from pydantic import AliasChoices, Field, SecretStr, ValidationError, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="MONEYLENS_", extra="ignore")
    environment: Literal["development", "test", "staging", "production"] = "development"
    data_mode: Literal["synthetic"] = "synthetic"
    allow_demo: bool = True
    balance_maximum_age_hours: int = Field(default=24, ge=1, le=168)
    fallback_horizon_days: int = Field(default=30, ge=30, le=90)
    interactive_horizon_days: int = Field(default=90, ge=30, le=365)
    database_url: SecretStr | None = None
    auth_enabled: bool = False
    auth_database_url: SecretStr | None = None
    session_secret: SecretStr | None = None
    app_origin: str = "http://127.0.0.1:3000"
    pool_max_size: int = Field(default=10, ge=1, le=50)
    session_seconds: int = Field(default=3600, ge=300, le=86400)
    session_idle_seconds: int = Field(default=900, ge=60, le=3600)
    oidc_issuer: str | None = None
    oidc_client_id: str | None = None
    oidc_client_secret: SecretStr | None = None
    oidc_authorization_url: str | None = None
    oidc_token_url: str | None = None
    oidc_jwks_url: str | None = None
    oidc_self_signup_enabled: bool = False
    # Explicit opt-in, read-only PSD2/AIS connector. Only verified non-demo identities.
    live_banking_enabled: bool = False
    enable_banking_environment: Literal["sandbox","production"] = "sandbox"
    enable_banking_app_id: str | None = Field(default=None,pattern=r"^[0-9a-fA-F-]{36}$")
    enable_banking_private_key_pem: SecretStr | None = None
    live_banking_cipher_key: SecretStr | None = None
    psu_proxy_secret: SecretStr | None = Field(default=None,min_length=32)
    statement_imports_enabled: bool = False
    imports_enabled: bool = False
    object_store_endpoint: str | None = None
    object_store_bucket: str | None = Field(default=None,pattern=r"^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$")
    object_store_access_key: SecretStr | None = None
    object_store_secret_key: SecretStr | None = None
    object_store_region: str = Field(default="us-east-1",pattern=r"^[a-z0-9-]{1,40}$")
    import_maximum_bytes: int = Field(default=1024**3,ge=1024,le=5*1024**3)
    import_daily_bytes: int = Field(default=2*1024**3,ge=1024,le=50*1024**3)
    import_upload_link_seconds: int = Field(default=600,ge=60,le=900)
    model_enabled: bool = False
    # User's zero-charge requirement: a complimentary quota is not a free-only API.
    model_billing_policy: Literal["free_only", "paid_allowed"] = "free_only"
    openai_api_key: SecretStr | None = None
    model_provider: Literal["openai", "gemini"] = "openai"
    gemini_api_key: SecretStr | None = Field(default=None,validation_alias=AliasChoices("MONEYLENS_GEMINI_API_KEY","GEMINI_API_KEY"))
    model_name: str = Field(default="gpt-5.4-mini-2026-03-17", pattern=r"^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,99}$")
    model_timeout_seconds: int = Field(default=10, ge=1, le=30)
    model_max_concurrency: int = Field(default=4, ge=1, le=32)
    model_max_input_bytes: int = Field(default=32768, ge=1024, le=65536)
    model_max_output_tokens: int = Field(default=2048, ge=256, le=8192)
    model_max_calls: int = Field(default=6, ge=1, le=6)
    model_max_tool_calls: int = Field(default=6, ge=1, le=6)
    model_turn_budget_microusd: int = Field(default=250000, ge=1, le=1000000)
    # Explicit operator opt-out removes only monetary admission, never technical bounds.
    model_cost_limit_enabled: bool = True
    # Operator-reviewed upper rates: micro-USD per token (same numeral as USD / 1M).
    model_input_microusd_per_token: int = Field(default=1, ge=1, le=1000)
    model_output_microusd_per_token: int = Field(default=5, ge=1, le=1000)
    model_daily_token_cap: int = Field(default=100000, ge=1, le=10000000)
    model_user_rate_seconds: int = Field(default=5, ge=1, le=3600)

    @field_validator("gemini_api_key",mode="before")
    @classmethod
    def optional_gemini_key(cls,value):
        return None if value=="" else value

    @model_validator(mode="after")
    def safe_mode(self):
        if self.model_provider=="gemini" and self.model_name!="gemini-3.5-flash":
            raise ValueError("The Gemini interpreter requires the reviewed gemini-3.5-flash model")
        if self.model_name!="gpt-5.4-mini-2026-03-17" and not {"model_input_microusd_per_token", "model_output_microusd_per_token"}<=self.model_fields_set:
            raise ValueError("A different model requires explicitly reviewed input/output cost rates")
        for credential in (self.openai_api_key,self.gemini_api_key):
            if credential is None: continue
            value = credential.get_secret_value()
            if not value or len(value)>512 or not value.isascii() or any(c.isspace() for c in value):
                raise ValueError("The model credential must be a nonempty ASCII token without whitespace")
        if self.environment == "production" and self.allow_demo:
            raise ValueError("The public synthetic demo must be explicitly disabled in production")
        origin = urlsplit(self.app_origin)
        local = self.environment in ("development", "test")
        if self.oidc_self_signup_enabled and (not self.auth_enabled or not all((
            self.oidc_issuer, self.oidc_client_id, self.oidc_client_secret,
            self.oidc_authorization_url, self.oidc_token_url, self.oidc_jwks_url,
        ))):
            raise ValueError("Self-service signup requires authenticated sessions and a complete OIDC provider")
        if self.live_banking_enabled:
            if not self.auth_enabled or not all((self.enable_banking_app_id,self.enable_banking_private_key_pem,self.live_banking_cipher_key)):
                raise ValueError("Live banking requires authenticated sessions, an application ID, an RSA key and an encryption key")
            if not all((self.oidc_issuer,self.oidc_client_id,self.oidc_client_secret,self.oidc_authorization_url,self.oidc_token_url,self.oidc_jwks_url)):
                raise ValueError("Live banking requires a verified OIDC identity provider, not a synthetic demo identity")
            if not local and origin.scheme != "https":
                raise ValueError("Live banking requires HTTPS")
            # Validate the signing key and encryption key before accepting traffic.
            try:
                from uuid import UUID
                from cryptography.hazmat.primitives import serialization
                from cryptography.hazmat.primitives.asymmetric import rsa
                UUID(self.enable_banking_app_id)
                key = serialization.load_pem_private_key(
                    self.enable_banking_private_key_pem.get_secret_value().replace("\\n","\n").encode(),password=None)
                if not isinstance(key,rsa.RSAPrivateKey) or key.key_size<2048:
                    raise ValueError("Enable Banking requires an RSA key")
            except (ValueError,TypeError,UnicodeError):
                raise ValueError("Live banking requires a valid RSA signing key and application ID") from None
            try:
                from cryptography.fernet import Fernet
                Fernet(self.live_banking_cipher_key.get_secret_value().encode("ascii"))
            except (ValueError,TypeError,UnicodeError):
                raise ValueError("Use a valid base64url Fernet key for the live banking vault") from None
        if self.imports_enabled:
            if not self.auth_enabled or not all((self.object_store_endpoint,self.object_store_bucket,self.object_store_access_key,self.object_store_secret_key)):
                raise ValueError("Imports require verified sessions and explicit private object storage")
            for credential in (self.object_store_access_key,self.object_store_secret_key):
                value=credential.get_secret_value()
                if not value or len(value)>512 or not value.isascii() or any(c.isspace() for c in value):
                    raise ValueError("Use nonempty ASCII object-store credentials without whitespace")
            endpoint=urlsplit(self.object_store_endpoint)
            if endpoint.path not in ("", "/") or endpoint.query or endpoint.fragment or endpoint.username or endpoint.password or not endpoint.netloc:
                raise ValueError("Use an explicit trusted object-store origin")
            if endpoint.scheme!="https" and not (local and endpoint.scheme=="http" and endpoint.hostname in ("localhost","127.0.0.1")):
                raise ValueError("Object storage requires HTTPS outside loopback development")
            if self.import_daily_bytes<self.import_maximum_bytes:
                raise ValueError("The daily import budget must cover one permitted manifest")
        if origin.path or origin.query or origin.fragment or origin.username or origin.password or not origin.netloc:
            raise ValueError("app_origin must be an exact origin without credentials or path")
        if self.auth_enabled and origin.scheme != "https" and not (local and origin.scheme == "http" and origin.hostname in ("localhost", "127.0.0.1")):
            raise ValueError("Use HTTPS except for explicit local development")
        if self.auth_enabled:
            if not self.database_url or not self.auth_database_url or not self.session_secret or len(self.session_secret.get_secret_value()) < 32:
                raise ValueError("Authentication requires separate runtime/identity URLs and a session secret of at least 32 characters")
            oidc = [self.oidc_issuer, self.oidc_client_id, self.oidc_client_secret, self.oidc_authorization_url, self.oidc_token_url, self.oidc_jwks_url]
            if any(oidc) and not all(oidc):
                raise ValueError("Configure every OIDC endpoint and client credential together")
            if not self.allow_demo and not all(oidc):
                raise ValueError("Non-demo authentication requires an OIDC provider")
            for endpoint in (self.oidc_issuer, self.oidc_authorization_url, self.oidc_token_url, self.oidc_jwks_url):
                if endpoint:
                    parsed = urlsplit(endpoint)
                    if parsed.scheme != "https" or not parsed.netloc or parsed.username or parsed.password or parsed.query or parsed.fragment:
                        raise ValueError("OIDC endpoints must be explicit trusted HTTPS URLs")
        return self


@lru_cache
def get_settings() -> Settings:
    try:
        return Settings()
    except ValidationError:
        # Startup tracebacks must not include Pydantic's raw environment input.
        raise RuntimeError("Invalid application settings. Review local environment configuration.") from None
