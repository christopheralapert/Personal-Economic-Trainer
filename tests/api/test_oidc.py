import time
import base64
import hashlib
from urllib.parse import parse_qs, urlsplit

from cryptography.hazmat.primitives.asymmetric import rsa
import httpx
import jwt
import pytest

from app.identity import AuthError
from app.oidc import OIDC
from app.settings import Settings


@pytest.fixture(scope="module")
def private_key():
    return rsa.generate_private_key(public_exponent=65537,key_size=2048)


def provider_settings(**overrides):
    return Settings(environment="test",auth_enabled=True,database_url="postgresql://runtime.invalid/db",
        auth_database_url="postgresql://identity.invalid/db",session_secret="test-only-key-with-32-characters-minimum",
        oidc_issuer="https://identity.example",oidc_client_id="moneylens",oidc_client_secret="test-only-client-secret",
        oidc_authorization_url="https://identity.example/authorize",oidc_token_url="https://identity.example/token",
        oidc_jwks_url="https://identity.example/keys",**overrides)


@pytest.fixture
def provider(private_key):
    key = {**jwt.algorithms.RSAAlgorithm.to_jwk(private_key.public_key(),as_dict=True),"kid":"test-key","alg":"RS256","use":"sig"}
    requests = []
    document = {"keys":[key]}
    def respond(request):
        requests.append(request)
        assert str(request.url) == "https://identity.example/keys"
        return httpx.Response(200,json=document)
    instance = OIDC(provider_settings(),httpx.Client(transport=httpx.MockTransport(respond)))
    yield instance,requests,document
    instance.close()


def token(private_key,oidc,**changes):
    now = int(time.time())
    claims = {"iss":"https://identity.example","sub":"verified-subject","aud":"moneylens",
        "exp":now+600,"iat":now,"auth_time":now,"nonce":oidc.nonce("state-test")}
    claims.update(changes)
    return jwt.encode(claims,private_key,algorithm="RS256",headers={"kid":"test-key"})


def test_rs256_identity_is_verified_and_public_keys_are_cached(provider,private_key):
    oidc,requests,_ = provider
    assert oidc.verify(token(private_key,oidc),"state-test") == "verified-subject"
    assert oidc.verify(token(private_key,oidc),"state-test") == "verified-subject"
    assert len(requests) == 1


@pytest.mark.parametrize("change", [
    {"iss":"https://evil.example"},{"aud":"another-client"},{"nonce":"forged"},{"sub":""},
    {"exp":0},{"iat":int(time.time())+300},{"auth_time":int(time.time())-600},
    {"auth_time":True},{"exp":"9999999999"},{"aud":["moneylens","other"]},{"azp":"other"},
])
def test_invalid_identity_claims_are_rejected(provider,private_key,change):
    oidc,_,_ = provider
    with pytest.raises(AuthError) as error:
        oidc.verify(token(private_key,oidc,**change),"state-test")
    assert error.value.code == "INVALID_IDENTITY"


def test_wrong_signature_and_hmac_algorithm_are_rejected(provider,private_key):
    oidc,requests,_ = provider
    other_key = rsa.generate_private_key(public_exponent=65537,key_size=2048)
    with pytest.raises(AuthError):
        oidc.verify(token(other_key,oidc),"state-test")
    encoded = jwt.encode({"sub":"fake"},"not-the-provider-key-32-chars-long",algorithm="HS256",headers={"kid":"test-key"})
    with pytest.raises(AuthError):
        oidc.verify(encoded,"state-test")
    assert len(requests) == 1


def test_jwks_rotation_refresh_is_bounded(provider,private_key):
    oidc,requests,document = provider
    oidc.verify(token(private_key,oidc),"state-test")
    encoded = token(private_key,oidc)
    claims = jwt.decode(encoded,options={"verify_signature":False})
    rotated = jwt.encode(claims,private_key,algorithm="RS256",headers={"kid":"rotated"})
    document["keys"].append({**document["keys"][0],"kid":"rotated"})
    for _ in range(3):
        with pytest.raises(AuthError):
            oidc.verify(rotated,"state-test")
    assert len(requests) == 1
    oidc.fetched_at -= 31
    assert oidc.verify(rotated,"state-test") == "verified-subject"
    assert len(requests) == 2


def test_authorization_url_binds_redirect_nonce_and_pkce(provider):
    oidc,_,_ = provider
    parsed = urlsplit(oidc.authorization_url("random-state"))
    query = parse_qs(parsed.query)
    assert parsed.scheme == "https" and parsed.netloc == "identity.example"
    assert query["redirect_uri"] == ["http://127.0.0.1:3000/api/v1/auth/callback"]
    assert query["code_challenge_method"] == ["S256"]
    assert query["state"] == ["random-state"] and query["nonce"] == [oidc.nonce("random-state")]
    assert oidc.verifier("random-state") not in parsed.query
    forced=parse_qs(urlsplit(oidc.authorization_url("new-state",reauthenticate=True)).query)
    assert forced['prompt']==['login'] and forced['max_age']==['0']
    assert forced['state']==['new-state'] and forced['code_challenge_method']==['S256']


def test_code_exchange_keeps_tokens_on_the_backend(private_key):
    jwk = {**jwt.algorithms.RSAAlgorithm.to_jwk(private_key.public_key(),as_dict=True),"kid":"test-key"}
    requests = []
    oidc = None
    def respond(request):
        requests.append(request)
        if request.method == "GET":
            return httpx.Response(200,json={"keys":[jwk]})
        form = parse_qs(request.content.decode())
        assert form["code_verifier"] == [oidc.verifier("state-test")]
        assert form["redirect_uri"] == [oidc.redirect_uri]
        assert request.headers["Authorization"].startswith("Basic ")
        return httpx.Response(200,json={"id_token":token(private_key,oidc),"access_token":"backend-only-token"})
    oidc = OIDC(provider_settings(),httpx.Client(transport=httpx.MockTransport(respond)))
    try:
        assert oidc.exchange("authorization-code","state-test") == "verified-subject"
        assert len(requests) == 2
    finally:
        oidc.close()


def test_access_token_hash_is_checked_when_present(provider,private_key):
    oidc,_,_ = provider
    access = "backend-only-access-token"
    hashed = base64.urlsafe_b64encode(hashlib.sha256(access.encode()).digest()[:16]).decode().rstrip("=")
    encoded = token(private_key,oidc,at_hash=hashed)
    assert oidc.verify(encoded,"state-test",access) == "verified-subject"
    for wrong in (None,"different-token"):
        with pytest.raises(AuthError):
            oidc.verify(encoded,"state-test",wrong)


@pytest.mark.parametrize("document", [{"keys":[]},{"keys":["malformed"]},{"keys":"wrong"}])
def test_malformed_provider_keys_fail_safely(private_key,document):
    oidc = OIDC(provider_settings(),httpx.Client(transport=httpx.MockTransport(lambda request: httpx.Response(200,json=document))))
    try:
        with pytest.raises(AuthError) as error:
            oidc.verify(token(private_key,oidc),"state-test")
        assert error.value.code == "IDENTITY_PROVIDER_UNAVAILABLE"
    finally:
        oidc.close()
