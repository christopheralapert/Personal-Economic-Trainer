"""Offline readiness tests: no bank consent or personal-data access."""
import json
from pathlib import Path
import runpy
from uuid import uuid4

from cryptography.fernet import Fernet
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
import httpx
import pytest

from app.live_banking_preflight import MetadataOnlyClient, preflight
from app.live_banking_provider import LiveProviderError
from app.settings import Settings


@pytest.fixture
def configured():
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    pem = key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                            serialization.NoEncryption()).decode()
    return Settings(
        environment="test", allow_demo=False, auth_enabled=True,
        database_url="postgresql://runtime:offline@localhost/test",
        auth_database_url="postgresql://identity:offline@localhost/test",
        session_secret="s" * 32, app_origin="https://moneylens.example",
        oidc_issuer="https://identity.example/", oidc_client_id="offline",
        oidc_client_secret="offline", oidc_authorization_url="https://identity.example/authorize",
        oidc_token_url="https://identity.example/token", oidc_jwks_url="https://identity.example/jwks",
        enable_banking_environment="production", enable_banking_app_id=str(uuid4()),
        enable_banking_private_key_pem=pem,
        live_banking_cipher_key=Fernet.generate_key().decode(),
    )


def test_offline_preflight_never_calls_provider_or_enables_runtime(configured):
    def forbidden(request):
        pytest.fail("Offline preflight must not perform network requests")
    report = preflight(configured, transport=httpx.MockTransport(forbidden))
    assert report["configuration_valid"] is True
    assert report["provider_checked"] is False
    assert configured.live_banking_enabled is False
    assert report["bank_authorization_started"] is False
    assert report["personal_data_read"] is False
    encoded = json.dumps(report)
    for secret in (configured.enable_banking_app_id,
                   configured.enable_banking_private_key_pem.get_secret_value(),
                   configured.live_banking_cipher_key.get_secret_value()):
        assert secret not in encoded


def test_missing_or_invalid_credentials_stop_before_network(configured):
    def forbidden(request):
        pytest.fail("Invalid credentials must stop before network access")
    transport = httpx.MockTransport(forbidden)
    missing = configured.model_copy(update={"enable_banking_app_id": None})
    assert preflight(missing, directory=True, transport=transport)["missing_settings"] == [
        "MONEYLENS_ENABLE_BANKING_APP_ID"]
    invalid = configured.model_copy(update={"live_banking_cipher_key": None})
    assert preflight(invalid, directory=True, transport=transport)["configuration_valid"] is False
    invalid = configured.model_copy(update={"auth_enabled": False})
    assert preflight(invalid, directory=True, transport=transport)["error"] == "BANK_CONFIGURATION_INVALID"


@pytest.mark.parametrize("method,path", [
    ("POST", "/auth"), ("POST", "/sessions"),
    ("GET", "/accounts/" + str(uuid4()) + "/balances"),
    ("GET", "/sessions/" + str(uuid4())), ("POST", "/payments"),
    ("DELETE", "/sessions/" + str(uuid4())),
])
def test_preflight_rejects_every_non_metadata_operation(configured, method, path):
    def forbidden(request):
        pytest.fail("Operation must be blocked before transport")
    client = MetadataOnlyClient(configured.enable_banking_app_id,
        configured.enable_banking_private_key_pem.get_secret_value(),
        transport=httpx.MockTransport(forbidden))
    with pytest.raises(LiveProviderError, match="BANK_PREFLIGHT_METADATA_ONLY"):
        client.request(method, path)


def test_directory_uses_only_verified_personal_institutions(configured):
    calls = []
    def handler(request):
        calls.append((request.method, request.url.path))
        if request.url.path == "/application":
            return httpx.Response(200, json={"kid": configured.enable_banking_app_id,
                "active": True, "environment": "PRODUCTION", "services": ["AIS"],
                "redirect_urls": [configured.app_origin + "/api/v1/live-banking/callback"]})
        country = request.url.params["country"]
        return httpx.Response(200, json={"aspsps": [
            {"name": "Wise", "country": country, "psu_types": ["personal"], "maximum_consent_validity": 86400},
            {"name": "Luminor", "country": country, "psu_types": ["business"], "maximum_consent_validity": 86400},
        ]})
    report = preflight(configured, directory=True, transport=httpx.MockTransport(handler))
    assert report["provider_checked"] is True
    assert report["restricted_account_links"] == "not_exposed_by_provider_metadata"
    assert list(report["directory"]) == ["EE", "FI", "LV", "LT", "SE"]
    assert [b["name"] for b in report["directory"]["EE"]["requested_banks"]] == ["Wise"]
    assert calls == [("GET", "/application")] + [("GET", "/aspsps")] * 5


def test_callback_mismatch_stops_directory_and_sanitizes_failure(configured):
    def handler(request):
        assert request.url.path == "/application"
        return httpx.Response(200, json={"kid": configured.enable_banking_app_id,
            "active": True, "environment": "PRODUCTION", "services": ["AIS"],
            "redirect_urls": ["https://wrong.example/callback"]})
    report = preflight(configured, directory=True, transport=httpx.MockTransport(handler))
    assert report["error"] == "BANK_APPLICATION_NOT_READY"
    assert report["provider_checked"] is False
    assert "directory" not in report


def test_partial_directory_is_not_reported_as_complete(configured):
    def handler(request):
        if request.url.path == "/application":
            return httpx.Response(200, json={"kid": configured.enable_banking_app_id,
                "active": True, "environment": "PRODUCTION", "services": ["AIS"],
                "redirect_urls": [configured.app_origin + "/api/v1/live-banking/callback"]})
        if request.url.params["country"] == "FI":
            return httpx.Response(503, text="sensitive upstream details")
        return httpx.Response(200, json={"aspsps": []})
    report = preflight(configured, directory=True, transport=httpx.MockTransport(handler))
    assert report["provider_checked"] is False
    assert "directory" not in report
    assert "sensitive" not in json.dumps(report)


def test_preflight_reads_pem_through_actual_node_runtime_parser(configured, tmp_path, monkeypatch):
    """A Python-only dotenv check previously accepted PEM that Node could not use."""
    name = "MONEYLENS_ENABLE_BANKING_PRIVATE_KEY_PEM"
    monkeypatch.delenv(name, raising=False)
    pem = configured.enable_banking_private_key_pem.get_secret_value()
    env_file = tmp_path / "bank.env"
    env_file.write_text(name + '=\"' + pem.replace("\n", r"\n") + '\"\n', encoding="utf8")
    script = Path(__file__).resolve().parents[2] / "scripts" / "check_live_banking.py"
    load = runpy.run_path(str(script))["read_runtime_environment"]
    runtime_pem = load(env_file)[name]
    key = serialization.load_pem_private_key(runtime_pem.encode(), password=None)
    assert key.key_size == 2048
    assert runtime_pem == pem

    # python-dotenv decodes doubled backslashes in single quotes, Node retains
    # them. Readiness must check what the API will actually receive.
    from dotenv import set_key, dotenv_values
    env_file.unlink()
    set_key(str(env_file), name, pem.replace("\n", r"\n"), quote_mode="always")
    assert dotenv_values(env_file)[name].replace(r"\n", "\n") == pem
    with pytest.raises(ValueError):
        serialization.load_pem_private_key(load(env_file)[name].replace(r"\n", "\n").encode(), password=None)
