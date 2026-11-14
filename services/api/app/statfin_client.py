"""Public-data-only client; no session, transaction or owner parameters exist here."""
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
import json
import threading
import time

import httpx

from .statfin import BASE, CONFIG_URL, SPEC


class ProviderError(RuntimeError):
    def __init__(self,code,retry_after_seconds=None):
        self.code,self.retry_after_seconds = code,retry_after_seconds
        super().__init__(code)


def retry_after(value):
    try:
        seconds = int(value)
    except (TypeError,ValueError):
        try:
            seconds = int((parsedate_to_datetime(value)-datetime.now(timezone.utc)).total_seconds())
        except (TypeError,ValueError,OverflowError):
            seconds = 60
    return max(1,min(86400,seconds))


class StatFinClient:
    def __init__(self,client=None,*,clock=time.monotonic,sleep=time.sleep):
        self.client = client or httpx.Client(timeout=httpx.Timeout(10,connect=5),follow_redirects=False)
        self.clock,self.sleep = clock,sleep
        self.spacing,self.last_request,self.blocked_until = 2.0,None,0.0
        self.max_cells = 1000
        self.lock = threading.Lock()

    def request(self,method,url,query=None):
        allowed = {CONFIG_URL,BASE,BASE+"/14ph.px",BASE+"/14lv.px"}
        if url not in allowed or method not in ("GET","POST") or (method=="POST" and (query is None or url in (BASE,CONFIG_URL))):
            raise ValueError("Only explicit public-statistics operations are allowed")
        if method=="GET" and query is not None:
            raise ValueError("Public metadata requests do not accept personal parameters")
        if method=="POST":
            table = url.rsplit("/",1)[1][:-3]
            if not isinstance(query,dict) or set(query)!={"query","response"} or query["response"]!={"format":"json-stat2"}:
                raise ValueError("Only reviewed aggregate selections may be sent")
            selections = query["query"]
            if not isinstance(selections,list) or len(selections)!=len(SPEC[table]):
                raise ValueError("Unexpected public selection")
            seen = set()
            for item in selections:
                if not isinstance(item,dict) or set(item)!={"code","selection"} or item["code"] not in SPEC[table] or item["code"] in seen:
                    raise ValueError("Unexpected public selection")
                expected = {"filter":"item","values":SPEC[table][item["code"]]}
                if item["selection"]!=expected:
                    raise ValueError("Only the fixed public aggregate values are allowed")
                seen.add(item["code"])
        with self.lock:
            now = self.clock()
            if now<self.blocked_until:
                raise ProviderError("PROVIDER_THROTTLED",int(self.blocked_until-now)+1)
            wait = max(0,self.spacing-(now-self.last_request)) if self.last_request is not None else 0
            if wait>5:
                raise ProviderError("PROVIDER_BUDGET_DEFERRED",int(wait)+1)
            if wait:
                self.sleep(wait)
            self.last_request = self.clock()
            try:
                with self.client.stream(method,url,json=query if method=="POST" else None) as response:
                    if response.status_code==429:
                        delay = retry_after(response.headers.get("retry-after"))
                        self.blocked_until = self.clock()+delay
                        raise ProviderError("PROVIDER_THROTTLED",delay)
                    if response.status_code!=200:
                        raise ProviderError("PROVIDER_UNAVAILABLE")
                    chunks,total,started = [],0,self.clock()
                    for chunk in response.iter_bytes():
                        total += len(chunk)
                        if total>1048576 or self.clock()-started>30:
                            raise ProviderError("PROVIDER_RESPONSE_LIMIT")
                        chunks.append(chunk)
                    raw = b"".join(chunks)
                    json.loads(raw)
                    return raw
            except (httpx.HTTPError,ValueError):
                raise ProviderError("PROVIDER_UNAVAILABLE") from None

    def configure(self):
        raw = self.request("GET",CONFIG_URL)
        settings = json.loads(raw)
        try:
            calls,window,cells = settings["maxCalls"],settings["timeWindow"],settings["maxCells"]
            if any(type(value) is not int or value<1 for value in (calls,window,cells)):
                raise ValueError()
            self.spacing = max(2.0,window/calls)
            self.max_cells = min(1000,cells)
        except (KeyError,TypeError,ValueError):
            raise ProviderError("PROVIDER_CONFIG_CHANGED") from None
        return raw

    def close(self):
        self.client.close()
