import pytest
from pydantic import ValidationError

from app.settings import Settings
from test_oidc import provider_settings


def test_self_signup_defaults_to_disabled():
    assert Settings(_env_file=None).oidc_self_signup_enabled is False
    assert provider_settings().oidc_self_signup_enabled is False


def test_self_signup_requires_verified_session_and_complete_provider():
    with pytest.raises(ValidationError, match="Self-service signup requires"):
        Settings(oidc_self_signup_enabled=True)
    with pytest.raises(ValidationError, match="Self-service signup requires"):
        Settings(environment="test", auth_enabled=True, allow_demo=True,
            database_url="postgresql://runtime.invalid/db", auth_database_url="postgresql://identity.invalid/db",
            session_secret="test-only-session-secret-32-characters", oidc_self_signup_enabled=True)
    assert provider_settings(oidc_self_signup_enabled=True).oidc_self_signup_enabled is True


def test_self_signup_can_be_enabled_explicitly_in_environment(monkeypatch):
    monkeypatch.setenv("MONEYLENS_OIDC_SELF_SIGNUP_ENABLED", "true")
    assert provider_settings().oidc_self_signup_enabled is True
