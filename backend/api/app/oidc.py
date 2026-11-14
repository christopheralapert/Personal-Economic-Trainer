"""Pinned OIDC code flow; provider tokens never enter browser storage or domain tools."""
import base64
import hashlib
import hmac
import threading
import time
from urllib.parse import urlencode

import httpx
import jwt

from .identity import AuthError, derive


class OIDC:
    def __init__(self, settings, client=None):
        self.settings = settings
        self.client = client or httpx.Client(timeout=5, follow_redirects=False,
            limits=httpx.Limits(max_connections=5,max_keepalive_connections=5))
        self.keys = {}
        self.fetched_at = 0.0
        self.lock = threading.Lock()

    @property
    def redirect_uri(self):
        return self.settings.app_origin + "/api/v1/auth/callback"

    def verifier(self, state):
        return derive(self.settings.session_secret.get_secret_value(),"oidc.pkce.v1",state)

    def nonce(self, state):
        return derive(self.settings.session_secret.get_secret_value(),"oidc.nonce.v1",state)

    def authorization_url(self, state, *, reauthenticate=False):
        challenge = base64.urlsafe_b64encode(hashlib.sha256(self.verifier(state).encode()).digest()).decode().rstrip("=")
        parameters = {
            "client_id":self.settings.oidc_client_id,"redirect_uri":self.redirect_uri,
            "response_type":"code","scope":"openid","state":state,"nonce":self.nonce(state),
            "code_challenge":challenge,"code_challenge_method":"S256","max_age":"300",
        }
        if reauthenticate:
            parameters.update(prompt="login",max_age="0")
        return self.settings.oidc_authorization_url + "?" + urlencode(parameters)

    def _json(self, method, url, **kwargs):
        try:
            with self.client.stream(method,url,**kwargs) as response:
                response.raise_for_status()
                chunks, size = [], 0
                for chunk in response.iter_bytes():
                    size += len(chunk)
                    if size > 524288:
                        raise AuthError("IDENTITY_PROVIDER_UNAVAILABLE",503)
                    chunks.append(chunk)
                import json
                result = json.loads(b"".join(chunks))
                if not isinstance(result,dict):
                    raise ValueError()
                return result
        except (httpx.HTTPError,ValueError):
            raise AuthError("IDENTITY_PROVIDER_UNAVAILABLE",503) from None

    def _key(self, kid):
        with self.lock:
            age = time.monotonic()-self.fetched_at
            if not self.fetched_at or age > 300 or (kid not in self.keys and age > 30):
                document = self._json("GET",self.settings.oidc_jwks_url)
                keys = document.get("keys")
                if not isinstance(keys,list) or not 1 <= len(keys) <= 50:
                    raise AuthError("IDENTITY_PROVIDER_UNAVAILABLE",503)
                parsed = {}
                try:
                    for key in keys:
                        if not isinstance(key,dict):
                            raise ValueError()
                        if key.get("kty") == "RSA" and key.get("alg","RS256") == "RS256" and key.get("use","sig") == "sig":
                            if not isinstance(key.get("kid"),str) or key["kid"] in parsed:
                                raise ValueError()
                            if "key_ops" in key and "verify" not in key["key_ops"]:
                                continue
                            parsed[key["kid"]] = jwt.PyJWK.from_dict(key,algorithm="RS256").key
                            if parsed[key["kid"]].key_size < 2048:
                                raise ValueError()
                except (ValueError,TypeError,KeyError,jwt.PyJWTError):
                    raise AuthError("IDENTITY_PROVIDER_UNAVAILABLE",503) from None
                self.keys, self.fetched_at = parsed, time.monotonic()
            if kid not in self.keys:
                raise AuthError("INVALID_IDENTITY",401)
            return self.keys[kid]

    def verify(self, token, state, access_token=None):
        try:
            if not isinstance(token,str) or len(token)>16384:
                raise ValueError()
            header = jwt.get_unverified_header(token)
            kid = header.get("kid")
            if header.get("alg") != "RS256" or header.get("crit") or not isinstance(kid,str) or not 1 <= len(kid) <= 128:
                raise ValueError()
            claims = jwt.decode(token,self._key(kid),algorithms=["RS256"],audience=self.settings.oidc_client_id,
                issuer=self.settings.oidc_issuer,leeway=30,
                options={"require":["exp","iat","iss","aud","sub","nonce","auth_time"]})
            if any(type(claims[name]) is not int for name in ("iat","exp","auth_time")):
                raise ValueError()
            if not isinstance(claims["sub"],str) or not 1<=len(claims["sub"])<=255:
                raise ValueError()
            if not isinstance(claims["nonce"],str) or not hmac.compare_digest(claims["nonce"],self.nonce(state)):
                raise ValueError()
            if time.time()-claims["auth_time"]>330 or claims["auth_time"]>time.time()+30:
                raise ValueError()
            if claims["exp"]<=claims["iat"]:
                raise ValueError()
            if (isinstance(claims["aud"],list) and len(claims["aud"])>1) or "azp" in claims:
                if claims.get("azp") != self.settings.oidc_client_id:
                    raise ValueError()
            if "at_hash" in claims:
                if not isinstance(access_token,str) or not isinstance(claims["at_hash"],str):
                    raise ValueError()
                expected = base64.urlsafe_b64encode(hashlib.sha256(access_token.encode()).digest()[:16]).decode().rstrip("=")
                if not hmac.compare_digest(expected,claims["at_hash"]):
                    raise ValueError()
            return claims["sub"]
        except (jwt.PyJWTError,ValueError,TypeError,KeyError):
            raise AuthError("INVALID_IDENTITY",401) from None

    def exchange(self, code, state):
        if not code or len(code)>4096:
            raise AuthError("INVALID_LOGIN_RESPONSE",400)
        tokens = self._json("POST",self.settings.oidc_token_url,
            auth=(self.settings.oidc_client_id,self.settings.oidc_client_secret.get_secret_value()),
            data={"grant_type":"authorization_code","code":code,"redirect_uri":self.redirect_uri,"code_verifier":self.verifier(state)})
        return self.verify(tokens.get("id_token"),state,tokens.get("access_token"))

    def close(self):
        self.client.close()
