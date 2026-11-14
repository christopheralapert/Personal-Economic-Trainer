"""Read-only Enable Banking AIS client. Never accepts a caller-selected HTTP host.

API contract: https://enablebanking.com/docs/api/reference/
This is a server-side integration: bank passwords and provider session identifiers
must never reach a browser, AI prompt, application log or repository source tree.
"""
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation, DecimalException
from email.utils import parsedate_to_datetime
import hashlib
import json
import logging
import time
import re
from urllib.parse import urlsplit
from uuid import UUID

import httpx
import jwt

API_ORIGIN = "https://api.enablebanking.com"
MAX_ACCOUNTS = 10
MAX_PAGES = 10
MAX_ROWS = 1000
logger = logging.getLogger(__name__)


def raw_identity_evidence(entries):
    """Derived BOOK-only counts; never keep source references or row contents."""
    evidence = {"booked_rows_seen": 0, "booked_missing_reference": 0,
        "reference_absent": 0, "reference_null": 0, "reference_empty": 0,
        "reference_wrong_type": 0, "reference_too_long": 0,
        "missing_reference_with_volatile_locator": 0}
    for entry in entries:
        if not isinstance(entry, dict) or entry.get("status") != "BOOK":
            continue
        evidence["booked_rows_seen"] += 1
        reference = entry.get("entry_reference")
        if isinstance(reference, str) and 1 <= len(reference) <= 2000:
            continue
        evidence["booked_missing_reference"] += 1
        reason = ("reference_absent" if "entry_reference" not in entry else
            "reference_null" if reference is None else
            "reference_wrong_type" if not isinstance(reference, str) else
            "reference_empty" if not reference else "reference_too_long")
        evidence[reason] += 1
        locator = entry.get("transaction_id")
        if isinstance(locator, str) and locator:
            evidence["missing_reference_with_volatile_locator"] += 1
    return evidence


def raw_conflict_evidence(entries, page_numbers):
    """Only derived flags; never return references, account hashes or money."""
    seen = {}
    for entry, page in zip(entries, page_numbers):
        if not isinstance(entry, dict) or entry.get("status") != "BOOK":
            continue
        reference = entry.get("entry_reference")
        if not isinstance(reference, str) or not 1 <= len(reference) <= 2000:
            continue
        if reference in seen:
            previous, first_page = seen[reference]
            try:
                # Validate currencies/precision before making a diagnostic claim.
                before = amount_minor(previous.get("transaction_amount"))
                after = amount_minor(entry.get("transaction_amount"))
                before_date = date.fromisoformat(previous.get("booking_date"))
                after_date = date.fromisoformat(entry.get("booking_date"))
            except (LiveProviderError, ValueError, TypeError):
                continue
            direction_changed = previous.get("credit_debit_indicator") != entry.get("credit_debit_indicator")
            if before != after or before_date != after_date or direction_changed:
                return {"raw_conflict": True, "both_booked": True,
                    "same_page": first_page == page, "first_page": first_page, "second_page": page,
                    "raw_amount_differs": before != after, "raw_booking_date_differs": before_date != after_date,
                    "raw_direction_differs": direction_changed}
        else:
            seen[reference] = (entry, page)
    return {"raw_conflict": False}


class LiveProviderError(Exception):
    """Errors exposed as constant codes, never a bank's raw error response."""
    def __init__(self, code="BANK_PROVIDER_UNAVAILABLE", status=503, *, retry_at=None, stage=None, provider_code=None, request_id=None):
        self.code, self.status = code, status
        self.retry_at, self.stage, self.provider_code, self.request_id = retry_at, stage, provider_code, request_id
        self.observed_at = datetime.now(timezone.utc)
        self.wait = None
        super().__init__(code)


def retry_after_time(value, now):
    """Both RFC Retry-After forms; never guess the provider's cooldown."""
    if not isinstance(value,str) or len(value)>128:
        return None
    try:
        if re.fullmatch(r"[0-9]{1,10}",value.strip()):
            return now+timedelta(seconds=int(value.strip()))
        result=parsedate_to_datetime(value)
        return max(now,result.astimezone(timezone.utc)) if result.tzinfo else None
    except (ValueError,TypeError,OverflowError):
        return None


def account_uuid(value):
    try:
        return str(UUID(value))
    except (TypeError, ValueError, AttributeError):
        raise LiveProviderError("BANK_PROVIDER_INVALID_DATA") from None


def amount_minor(data):
    """Reject fractional cents, unknown currencies and floating-point inputs."""
    if not isinstance(data, dict) or not isinstance(data.get("amount"), str) or data.get("currency") != "EUR":
        raise LiveProviderError("BANK_UNSUPPORTED_CURRENCY", 422)
    try:
        amount = Decimal(data["amount"])
        cents = amount * 100
        if not cents.is_finite() or cents != cents.to_integral_value() or abs(cents) > (2**53 - 1):
            raise InvalidOperation
        return int(cents)
    except (DecimalException, ValueError):
        raise LiveProviderError("BANK_PROVIDER_INVALID_DATA") from None


def classify_transaction(entry):
    """Conservative transparent rules. Unknown transfers must NOT become confident advice."""
    from .transaction_classification import category_for_mcc
    return category_for_mcc(entry.get('merchant_category_code'))


def normalize_transactions(entries, account_id):
    """Normalize settled entries only; preserve weak-identity and coverage warnings."""
    result = []
    seen = {}
    for entry in entries:
        if not isinstance(entry, dict):
            logger.warning("BANK_NORMALIZATION_INVALID field=entry_shape")
            raise LiveProviderError("BANK_PROVIDER_INVALID_DATA")
        if entry.get("status") != "BOOK":
            continue
        try:
            amount = amount_minor(entry.get("transaction_amount"))
        except LiveProviderError:
            logger.warning("BANK_NORMALIZATION_INVALID field=transaction_amount")
            raise
        indicator = entry.get("credit_debit_indicator")
        if indicator not in ("DBIT", "CRDT"):
            logger.warning("BANK_NORMALIZATION_INVALID field=credit_debit_indicator")
            raise LiveProviderError("BANK_PROVIDER_INVALID_DATA")
        amount = -abs(amount) if indicator == "DBIT" else abs(amount)
        booking = entry.get("booking_date")
        try:
            booked_on = date.fromisoformat(booking)
        except (ValueError, TypeError):
            logger.warning("BANK_NORMALIZATION_INVALID field=booking_date")
            raise LiveProviderError("BANK_PROVIDER_INVALID_DATA") from None
        # Only the immutable entry_reference identifies a booked transaction.
        # transaction_id is a volatile details locator, not an import identity.
        bank_id = entry.get("entry_reference")
        if not isinstance(bank_id, str) or not 1 <= len(bank_id) <= 2000:
            raise LiveProviderError("BANK_TRANSACTION_ID_REQUIRED",422)
        # Stable bank-provided entry IDs survive a new consent/session. The final
        # ledger UUID remains scoped to the canonical bank account.
        reference = hashlib.sha256(bank_id.encode()).hexdigest()
        party = entry.get("creditor") if amount < 0 else entry.get("debtor")
        name = party.get("name") if isinstance(party, dict) else None
        merchant = str(name or "Unknown counterparty")[:2000]
        category, basket = classify_transaction(entry)
        flow = "expense" if amount < 0 else "unknown"
        # Never try to infer 'safe to spend' from an uncategorised transfer.
        if category == "unclassified":
            flow = "unknown"
        # Compare the actual ledger payload, not unused counterparty address or
        # volatile details metadata. Financial/classification conflicts still
        # stop the entire import; never invent a replacement source identity.
        fields = ("amount", "booking_date", "merchant", "category", "basket", "economic_flow")
        canonical = (amount, booked_on, merchant, category, basket, flow)
        if reference in seen:
            if seen[reference] != canonical:
                changed = [name for name, old, new in zip(fields, seen[reference], canonical) if old != new]
                # Fixed field names only: no references, names, amounts or dates.
                logger.warning("BANK_DUPLICATE_SOURCE_ID conflicting_fields=%s", ",".join(changed))
                raise LiveProviderError("BANK_DUPLICATE_SOURCE_ID",409)
            continue
        seen[reference] = canonical
        result.append({"reference": reference, "amount_minor": amount, "booked_on": booked_on,
            "merchant": merchant, "category": category, "basket": basket,
            "economic_flow": flow, "status": "booked"})
    return result


class EnableBankingClient:
    def __init__(self, app_id, private_key, *, transport=None, expected_environment="sandbox"):
        self.app_id = str(UUID(app_id))
        self.expected_environment=expected_environment.upper()
        self.private_key = private_key.replace("\\n", "\n")
        # Transport injection is solely for offline tests, not a URL override.
        self.transport = transport
        self.deadline = time.monotonic()+11
        self.request_metadata = []
        self.psu_headers = {}

    def configure_psu(self, headers, country, name):
        institution=next((item for item in self.institutions(country) if item["name"]==name),None)
        if institution is None:
            raise LiveProviderError("BANK_INSTITUTION_UNAVAILABLE",409,stage="institution_metadata")
        available={key.lower() for key in headers}
        if any(key.lower() not in available for key in institution.get("required_psu_headers",[])):
            raise LiveProviderError("BANK_PSU_HEADERS_REQUIRED",422,stage="institution_metadata")
        self.psu_headers=dict(headers)
        # Two selected accounts can require several pages each. Still bounded;
        # a deadline failure never publishes the first account on its own.
        self.deadline=time.monotonic()+60

    def _jwt(self):
        now = int(datetime.now(timezone.utc).timestamp())
        return jwt.encode({"iss": "enablebanking.com", "aud": "api.enablebanking.com", "iat": now, "exp": now + 300},
            self.private_key, algorithm="RS256", headers={"typ": "JWT", "kid": self.app_id})

    def currency_failure_evidence(self, stage, currency, *, amount=None, metadata_start=0):
        # Structural flags only; no currency value, amount, account ID or body.
        logger.warning("BANK_CURRENCY_DIAGNOSTICS %s", json.dumps({
            "stage": stage, "currency_eur": currency == "EUR",
            "currency_missing": currency is None,
            "declared_multicurrency": currency == "XXX",
            "currency_code_shape_valid": isinstance(currency, str) and re.fullmatch(r"[A-Z]{3}", currency) is not None,
            "amount_is_string": isinstance(amount, str) if stage != "account_details" else None,
            "verified_identity_supplied": True,
            "request_metadata": self.request_metadata[metadata_start:]}))

    def request(self, method, path, *, params=None, body=None):
        if not re.fullmatch(r"/(?:aspsps|application|auth|sessions(?:/[0-9a-f-]{36})?|accounts/[0-9a-f-]{36}/(?:details|balances|transactions))",path) or method not in ("GET","POST","DELETE"):
            raise LiveProviderError("BANK_PROVIDER_INVALID_REQUEST")
        if time.monotonic()>=self.deadline:
            raise LiveProviderError("BANK_FETCH_DEADLINE",503)
        try:
            with httpx.Client(timeout=max(.1,min(5,self.deadline-time.monotonic())),follow_redirects=False,trust_env=False,transport=self.transport) as client:
                psu=self.psu_headers if path.startswith("/accounts/") or path.startswith("/sessions/") else {}
                with client.stream(method,API_ORIGIN+path,params=params,json=body,headers={**psu,"Authorization":"Bearer "+self._jwt(),"Accept":"application/json"}) as response:
                    chunks=[];size=0
                    for chunk in response.iter_bytes():
                        size+=len(chunk)
                        if size>1_000_000 or time.monotonic()>self.deadline:raise LiveProviderError("BANK_PROVIDER_INVALID_DATA")
                        chunks.append(chunk)
                    content=b"".join(chunks)
            # Record only actually observed, UUID-shaped correlation headers.
            # Never log paths, query strings, cursors, session/account IDs or bodies.
            request_ids = {}
            for header in ("x-request-id", "request-id", "x-correlation-id"):
                value = response.headers.get(header, "")
                if re.fullmatch(r"[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}", value):
                    request_ids[header] = value
            resource = path.rsplit("/", 1)[-1]
            if resource in ("details", "balances", "transactions") and len(self.request_metadata) < 128:
                self.request_metadata.append({"resource": resource,
                    "method": method, "status": response.status_code,
                    "observed_request_ids": request_ids,
                    "at_utc": datetime.now(timezone.utc).isoformat()})
            if method=="DELETE" and response.status_code==404:return {}
            if response.status_code == 429:
                try: error_body=json.loads(content)
                except (ValueError,UnicodeError): error_body={}
                upstream=error_body.get("error") if isinstance(error_body,dict) else None
                safe_code="ASPSP_RATE_LIMIT_EXCEEDED" if upstream=="ASPSP_RATE_LIMIT_EXCEEDED" else None
                stage=resource if resource in ("details","balances","transactions","aspsps") else "session_verification"
                raise LiveProviderError("BANK_ASPSP_RATE_LIMIT_EXCEEDED" if safe_code else "BANK_PROVIDER_THROTTLED",429,
                    retry_at=retry_after_time(response.headers.get("retry-after"),datetime.now(timezone.utc)),
                    stage=stage,provider_code=safe_code,request_id=next(iter(request_ids.values()),None))
            if response.status_code in (401,403):
                raise LiveProviderError("BANK_PROVIDER_ACCESS_DENIED",503)
            if not 200 <= response.status_code < 300:
                raise LiveProviderError()
            if method == "DELETE":
                return {}
            result = json.loads(content)
            if not isinstance(result, dict):
                raise ValueError()
            return result
        except (httpx.TimeoutException, httpx.TransportError, ValueError, jwt.PyJWTError):
            raise LiveProviderError() from None

    def application(self,callback):
        data=self.request("GET","/application")
        services=data.get("services");redirects=data.get("redirect_urls")
        if not isinstance(services,list) or not isinstance(redirects,list) or data.get("kid")!=self.app_id or data.get("active") is not True or data.get("environment")!=self.expected_environment or "AIS" not in services or callback not in redirects:
            raise LiveProviderError("BANK_APPLICATION_NOT_READY",409)
        return data["environment"].lower()

    def institutions(self, country):
        if country not in ("EE", "FI", "LV", "LT", "SE"):
            raise LiveProviderError("BANK_COUNTRY_UNAVAILABLE",422)
        data = self.request("GET", "/aspsps", params={"country":country})
        result = []
        if not isinstance(data.get("aspsps"),list):raise LiveProviderError("BANK_PROVIDER_INVALID_DATA")
        for item in data["aspsps"]:
            if not isinstance(item,dict):
                continue
            if not isinstance(item.get("psu_types"),list) or "personal" not in item["psu_types"]:continue
            if type(item.get("maximum_consent_validity")) is not int or item["maximum_consent_validity"]<=0:raise LiveProviderError("BANK_PROVIDER_INVALID_DATA")
            name = item.get("name")
            if isinstance(name,str) and 1 <= len(name) <= 100 and item.get("country", country) == country:
                bank={"name":name,"country":country,"maximum_consent_validity":item["maximum_consent_validity"]}
                if "required_psu_headers" in item:
                    required=item["required_psu_headers"]
                    if not isinstance(required,list) or any(not isinstance(h,str) or not re.fullmatch(r"Psu-[A-Za-z-]{1,50}",h,re.I) for h in required):
                        raise LiveProviderError("BANK_PROVIDER_INVALID_DATA",stage="institution_metadata")
                    bank["required_psu_headers"]=required
                result.append(bank)
        if len(result)>500:
            raise LiveProviderError("BANK_DIRECTORY_LIMIT")
        priority=("swedbank","seb","lhv","luminor","coop","wise") if country=="EE" else ("s-pankki","op","nordea","danske") if country=="FI" else ()
        def rank(item):
            value=item["name"].lower()
            return next((i for i,name in enumerate(priority) if ((value=="op" or value.startswith("op ")) if name=="op" else name in value)),len(priority)),value
        return sorted(result,key=rank)

    def start(self, *, name, country, state, callback, maximum_consent_validity=3600):
        if type(maximum_consent_validity) is not int or maximum_consent_validity<=0:
            raise LiveProviderError("BANK_PROVIDER_INVALID_DATA")
        target=urlsplit(callback)
        if target.username or target.password or target.fragment or target.query or target.path!="/api/v1/live-banking/callback" or not (target.scheme=="https" or (target.scheme=="http" and target.hostname in ("127.0.0.1","localhost"))):
            raise LiveProviderError("BANK_PROVIDER_INVALID_REDIRECT")
        expires = datetime.now(timezone.utc) + timedelta(seconds=min(30*86400,maximum_consent_validity))
        data = self.request("POST", "/auth", body={
            "access":{"valid_until":expires.isoformat(),"balances":True,"transactions":True,"transactions_extended_history":False},
            "aspsp":{"name":name,"country":country},
            "state":state,"redirect_url":callback,"psu_type":"personal"})
        link = data.get("url")
        try:
            parsed = urlsplit(link) if isinstance(link,str) and len(link)<=8192 else None
            host = parsed.hostname or "" if parsed else ""
            trusted=parsed and parsed.scheme=="https" and (host=="enablebanking.com" or host.endswith(".enablebanking.com")) and parsed.port in (None,443) and not parsed.username and not parsed.password
        except ValueError:
            trusted=False
        if not trusted:
            raise LiveProviderError("BANK_PROVIDER_INVALID_REDIRECT")
        return link

    def authorize(self, code, *, expected_name, expected_country):
        if not isinstance(code,str) or not 1 <= len(code) <= 1024:
            raise LiveProviderError("BANK_CALLBACK_INVALID",422)
        # POST /sessions returns account resource objects (not just UUIDs).
        # GET /sessions/{id} returns canonical UUIDs and status=AUTHORIZED.
        data = self.request("POST", "/sessions", body={"code":code})
        session_id = account_uuid(data.get("session_id"))
        try:
            accounts,expiry=self._authorized_accounts(data,session_id,expected_name,expected_country)
        except LiveProviderError:
            # A code exchange may have created remote consent even if later
            # validation fails. Do not keep that session deliberately usable.
            try:self.revoke(session_id)
            except LiveProviderError:pass
            raise
        return session_id,accounts,expiry

    def _authorized_accounts(self,data,session_id,expected_name,expected_country):
        aspsp = data.get("aspsp")
        if not isinstance(aspsp,dict) or (
            aspsp.get("name"),aspsp.get("country")) != (expected_name,expected_country):
            raise LiveProviderError("BANK_SESSION_MISMATCH",409)
        resources = data.get("accounts")
        if not isinstance(resources,list) or not 1 <= len(resources) <= MAX_ACCOUNTS:
            raise LiveProviderError("BANK_ACCOUNT_LIMIT",422)
        posted_ids = [account_uuid(a.get("uid") if isinstance(a,dict) else a) for a in resources]
        if len(set(posted_ids)) != len(posted_ids):
            raise LiveProviderError("BANK_PROVIDER_INVALID_DATA")
        accounts, expiry, identities = self.verify_session(session_id,expected_name=expected_name,expected_country=expected_country)
        if set(accounts)!=set(posted_ids):
            raise LiveProviderError("BANK_SESSION_MISMATCH",409)
        return accounts,expiry

    def verify_session(self,session_id,*,expected_name,expected_country):
        verified=self.request("GET",f"/sessions/{account_uuid(session_id)}")
        aspsp=verified.get("aspsp",{})
        if verified.get("status") in ("EXPIRED","CANCELLED","CLOSED","REVOKED","INVALID"):
            raise LiveProviderError("BANK_CONSENT_EXPIRED",409)
        if not isinstance(aspsp,dict) or verified.get("status")!="AUTHORIZED" or (aspsp.get("name"),aspsp.get("country"))!=(expected_name,expected_country):
            raise LiveProviderError("BANK_SESSION_MISMATCH",409)
        accounts=verified.get("accounts")
        if not isinstance(accounts,list) or not 1<=len(accounts)<=MAX_ACCOUNTS:
            raise LiveProviderError("BANK_ACCOUNT_LIMIT",422)
        accounts=[account_uuid(value) for value in accounts]
        if len(set(accounts))!=len(accounts):raise LiveProviderError("BANK_SESSION_MISMATCH",409)
        identities={}
        account_data=verified.get("accounts_data")
        if not isinstance(account_data,list) or len(account_data)!=len(accounts):raise LiveProviderError("BANK_ACCOUNT_IDENTITY_REQUIRED",422)
        for item in account_data:
            if not isinstance(item,dict):raise LiveProviderError("BANK_PROVIDER_INVALID_DATA")
            uid=account_uuid(item.get("uid"));identity=item.get("identification_hash")
            if uid not in accounts or uid in identities or not isinstance(identity,str) or not 10<=len(identity)<=2048:
                raise LiveProviderError("BANK_ACCOUNT_IDENTITY_REQUIRED",422)
            identities[uid]=hashlib.sha256(identity.encode()).hexdigest()
        if set(identities)!=set(accounts) or len(set(identities.values()))!=len(accounts):
            raise LiveProviderError("BANK_ACCOUNT_IDENTITY_REQUIRED",422)
        try:
            expiry=datetime.fromisoformat(verified["access"]["valid_until"].replace("Z","+00:00"))
            if expiry.tzinfo is None or expiry<=datetime.now(timezone.utc):raise ValueError()
        except (TypeError,KeyError,ValueError,AttributeError):
            raise LiveProviderError("BANK_CONSENT_EXPIRED",409) from None
        return accounts,expiry,identities

    def fetch_account(self, account_id, *, from_date, to_date, identity_ref):
        metadata_start = len(self.request_metadata)
        self.account_validation_stage = "account_identity"
        try:
            return self._fetch_account(account_id, from_date=from_date, to_date=to_date, identity_ref=identity_ref)
        except LiveProviderError as exc:
            exc.stage=exc.stage or self.account_validation_stage
            exc.request_id=exc.request_id or next((value for item in reversed(self.request_metadata[metadata_start:]) for value in item["observed_request_ids"].values()),None)
            if exc.code == "BANK_PROVIDER_INVALID_DATA":
                logger.warning("BANK_VALIDATION_DIAGNOSTICS %s", json.dumps({
                    "stage": self.account_validation_stage,
                    "request_metadata": self.request_metadata[metadata_start:]}))
            raise

    def _fetch_account(self, account_id, *, from_date, to_date, identity_ref):
        account_id = account_uuid(account_id)
        if not isinstance(identity_ref,str) or not re.fullmatch(r"[a-f0-9]{64}",identity_ref):
            raise LiveProviderError("BANK_ACCOUNT_IDENTITY_REQUIRED",422)
        metadata_start = len(self.request_metadata)
        self.account_validation_stage = "account_details"
        details = self.request("GET",f"/accounts/{account_id}/details")
        currency = details.get("currency")
        if currency not in ("EUR", "XXX"):
            self.currency_failure_evidence("account_details", currency, metadata_start=metadata_start)
            raise LiveProviderError("BANK_UNSUPPORTED_CURRENCY",422)
        self.account_validation_stage = "balances"
        balances = self.request("GET",f"/accounts/{account_id}/balances").get("balances")
        if not isinstance(balances,list):
            raise LiveProviderError("BANK_PROVIDER_INVALID_DATA")
        # XXX is a documented unknown/multicurrency descriptor, not a money
        # currency. Derive an EUR observation only from explicit money fields.
        # Validate ALL balances: never silently select EUR from a mixed list.
        for balance in balances:
            value = balance.get("balance_amount") if isinstance(balance, dict) else None
            if not isinstance(value, dict) or value.get("currency") != "EUR" or not isinstance(value.get("amount"), str):
                self.currency_failure_evidence("balance", value.get("currency") if isinstance(value, dict) else None,
                    amount=value.get("amount") if isinstance(value, dict) else None, metadata_start=metadata_start)
            amount_minor(value)
        booked = next((b for kind in ("ITBD","CLBD","ITAV","CLAV") for b in balances if isinstance(b,dict) and b.get("balance_type")==kind),None)
        if not booked:
            raise LiveProviderError("BANK_BOOKED_BALANCE_UNAVAILABLE",422)
        balance_amount = booked.get("balance_amount")
        if not isinstance(balance_amount, dict) or balance_amount.get("currency") != "EUR" or not isinstance(balance_amount.get("amount"), str):
            self.currency_failure_evidence("balance", balance_amount.get("currency") if isinstance(balance_amount, dict) else None,
                amount=balance_amount.get("amount") if isinstance(balance_amount, dict) else None, metadata_start=metadata_start)
        amount = amount_minor(balance_amount)
        name = str(details.get("name") or "Bank account")[:200]
        # Never let loan/card credit or an unknown account become spendable cash.
        account_type = {"CACC":"current","SVGS":"savings","CARD":"credit","LOAN":"credit"}.get(details.get("cash_account_type"),"restricted")
        rows = []
        page_numbers = []
        cursor = None
        seen_cursors = set()
        observed = datetime.now(timezone.utc)
        base_params={"date_from":from_date.isoformat(),"date_to":to_date.isoformat(),"transaction_status":"BOOK"}
        for page_number in range(1, MAX_PAGES + 1):
            self.account_validation_stage = "transaction_pagination"
            params = dict(base_params)
            if cursor:
                params["continuation_key"] = cursor
            page=self.request("GET",f"/accounts/{account_id}/transactions",params=params)
            entries=page.get("transactions")
            if not isinstance(entries,list) or len(entries)>MAX_ROWS:
                raise LiveProviderError("BANK_PROVIDER_INVALID_DATA")
            rows.extend(entries)
            page_numbers.extend([page_number] * len(entries))
            if len(rows) > MAX_ROWS:
                raise LiveProviderError("BANK_PAGE_LIMIT",422)
            next_cursor = page.get("continuation_key")
            if next_cursor is None:
                break
            if not isinstance(next_cursor,str) or not 1 <= len(next_cursor) <= 4000 or next_cursor in seen_cursors:
                raise LiveProviderError("BANK_PROVIDER_INVALID_DATA")
            seen_cursors.add(next_cursor)
            cursor=next_cursor
        else:
            raise LiveProviderError("BANK_PAGE_LIMIT",422)
        for entry in rows:
            if not isinstance(entry, dict) or entry.get("status") != "BOOK":
                continue
            value = entry.get("transaction_amount")
            if not isinstance(value, dict) or value.get("currency") != "EUR" or not isinstance(value.get("amount"), str):
                self.currency_failure_evidence("booked_transaction", value.get("currency") if isinstance(value, dict) else None,
                    amount=value.get("amount") if isinstance(value, dict) else None, metadata_start=metadata_start)
                break
        identity_evidence = raw_identity_evidence(rows)
        if identity_evidence["booked_missing_reference"]:
            logger.warning("BANK_IDENTITY_DIAGNOSTICS %s", json.dumps({**identity_evidence,
                "booked_only": True, "single_account_endpoint": True,
                "verified_identity_supplied": True, "pagination_complete": True,
                "page_count": page_number, "stable_query_parameters": True,
                "request_metadata": self.request_metadata[metadata_start:]}))
        evidence = raw_conflict_evidence(rows, page_numbers)
        if evidence["raw_conflict"]:
            # Computed before normalization, within this one verified account
            # endpoint and BOOK scope. No raw transaction is retained in logs.
            logger.warning("BANK_FETCH_DIAGNOSTICS %s", json.dumps({**evidence,
                "single_account_endpoint": True, "verified_identity_supplied": True,
                "pagination_complete": True, "page_count": page_number,
                "stable_query_parameters": True, "cursor_cycle_detected": False,
                "request_metadata": self.request_metadata[metadata_start:]}))
        self.account_validation_stage = "transaction_normalization"
        normalized=normalize_transactions(rows,account_id)
        # The provider may supply a session-independent account identifier.
        # Hash it before durable storage; never persist raw IBAN/identification.
        self.account_validation_stage = "requested_booking_window"
        if any(not from_date <= item["booked_on"] <= to_date for item in normalized):
            raise LiveProviderError("BANK_PROVIDER_INVALID_DATA")
        return {"id":account_id,"identity_ref":identity_ref,
            "name":name,"currency":"EUR","source_account_currency":currency,"account_type":account_type,
            "balance_kind":"booked" if booked["balance_type"] in ("CLBD","ITBD") else "available",
            "amount_minor":amount,"transactions":normalized,"observed_at":observed}

    def revoke(self, session_id):
        return self.request("DELETE", f"/sessions/{account_uuid(session_id)}")
