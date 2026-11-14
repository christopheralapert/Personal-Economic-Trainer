"""Bounded structured decisions; this module has no database or tool-execution access."""
import copy
from dataclasses import dataclass, field
import json
import re
import time
from typing import Protocol

import anyio
import httpx
from pydantic import BaseModel, ValidationError

ENDPOINT = "https://api.openai.com/v1/responses"
MAX_RESPONSE_BYTES = 131072
MAX_TOOL_DEFINITIONS = 12


class ModelError(Exception):
    """Stable codes only: never retain provider bodies, prompts or credentials."""
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def closed_json(raw):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError("Duplicate JSON key")
            result[key] = value
        return result
    return json.loads(raw, object_pairs_hook=pairs,
        parse_constant=lambda _: (_ for _ in ()).throw(ValueError("Nonfinite JSON")))


def complete_arguments(value):
    if isinstance(value, BaseModel):
        if value.model_fields_set!=set(type(value).model_fields):
            raise ModelError("MODEL_INVALID_ARGUMENTS")
        for name in type(value).model_fields:
            complete_arguments(getattr(value, name))
    elif isinstance(value, (list, tuple)):
        for child in value:
            complete_arguments(child)


@dataclass(frozen=True)
class ToolDefinition:
    name: str
    description: str
    arguments: type[BaseModel] = field(repr=False)

    def schema(self):
        if not re.fullmatch(r"[a-z][a-z0-9_]{0,63}", self.name) or not 1<=len(self.description)<=1000:
            raise ValueError("Invalid tool definition")
        schema = copy.deepcopy(self.arguments.model_json_schema())
        def visit(node):
            if isinstance(node, dict):
                if node.get("type")=="object":
                    if node.get("additionalProperties") is not False or "properties" not in node:
                        raise ValueError("Tool argument objects must forbid extra fields")
                    node["required"] = list(node["properties"])
                node.pop("default", None)
                # Visit schema positions, not user property names such as 'default'.
                for keyword in ("properties", "$defs"):
                    for child in node.get(keyword, {}).values():
                        visit(child)
                for keyword in ("items", "anyOf", "allOf", "oneOf"):
                    if keyword in node:
                        visit(node[keyword])
            elif isinstance(node, list):
                for child in node:
                    visit(child)
        visit(schema)
        if schema.get("type")!="object":
            raise ValueError("Tool arguments must be an object")
        return {"type":"function", "name":self.name, "description":self.description,
            "parameters":schema, "strict":True}


@dataclass(frozen=True)
class ModelInput:
    instructions: str = field(repr=False)
    question: str = field(repr=False)


@dataclass(frozen=True)
class ToolCall:
    name: str
    arguments: BaseModel = field(repr=False)


@dataclass(frozen=True)
class ModelDecision:
    calls: tuple[ToolCall, ...] = field(repr=False)
    input_tokens: int
    output_tokens: int
    estimated_cost_microusd: int


class StructuredModel(Protocol):
    async def decide(self, request: ModelInput, tools: tuple[ToolDefinition, ...], budget: "TurnBudget") -> ModelDecision: ...
    async def close(self) -> None: ...


class TurnBudget:
    """One orchestration deadline/budget, shared across its sequential model calls."""
    def __init__(self, settings, *, clock=time.monotonic):
        self.clock = clock
        self.deadline = clock()+settings.model_timeout_seconds
        self.max_calls = settings.model_max_calls
        self.max_tools = settings.model_max_tool_calls
        self.limit = settings.model_turn_budget_microusd if settings.model_cost_limit_enabled else None
        self.calls = self.tools = self.cost = 0
        self.input_tokens = self.output_tokens = 0

    def remaining(self):
        remaining = self.deadline-self.clock()
        if remaining<=0:
            raise ModelError("MODEL_TIMEOUT")
        return remaining

    def reserve(self, amount):
        self.remaining()
        if self.calls>=self.max_calls or self.tools>=self.max_tools or (self.limit is not None and self.cost+amount>self.limit):
            raise ModelError("MODEL_BUDGET_EXCEEDED")
        self.calls += 1
        self.tools += 1
        # Uncertain/failed requests retain their full reservation; never blindly retry.
        self.cost += amount


class OpenAIResponses:
    def __init__(self, settings, *, transport=None):
        self.settings = settings
        self.slots = anyio.Semaphore(settings.model_max_concurrency)
        self.client = httpx.AsyncClient(transport=transport, follow_redirects=False, trust_env=False,
            timeout=httpx.Timeout(settings.model_timeout_seconds, connect=5),
            limits=httpx.Limits(max_connections=settings.model_max_concurrency,
                max_keepalive_connections=settings.model_max_concurrency))

    async def close(self):
        await self.client.aclose()

    async def decide(self, request, tools, budget):
        config = self.settings
        if not config.model_enabled or not config.openai_api_key:
            raise ModelError("MODEL_NOT_CONFIGURED")
        if config.model_billing_policy!="paid_allowed":
            # Neither a model name, remaining local budget nor a shared daily
            # allowance proves the provider will charge zero for the next call.
            # Do not even preflight with the provider: refuse before any request.
            raise ModelError("MODEL_FREE_ONLY_UNAVAILABLE")
        if not isinstance(request, ModelInput) or not isinstance(request.question, str) or not request.question.strip() or not isinstance(request.instructions, str):
            raise ModelError("MODEL_INVALID_INPUT")
        try:
            question_size = len(request.question.encode("utf-8"))
            request.instructions.encode("utf-8")
        except UnicodeError:
            raise ModelError("MODEL_INVALID_INPUT") from None
        if question_size>8192 or not 1<=len(tools)<=MAX_TOOL_DEFINITIONS or len({tool.name for tool in tools})!=len(tools):
            raise ModelError("MODEL_INPUT_LIMIT")
        definitions = [tool.schema() for tool in tools]
        payload = {"model":config.model_name, "instructions":request.instructions,
            "input":[{"role":"user", "content":request.question}], "tools":definitions,
            "tool_choice":"required", "parallel_tool_calls":False, "store":False,
            "max_output_tokens":config.model_max_output_tokens}
        raw = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        if len(raw)>config.model_max_input_bytes:
            raise ModelError("MODEL_INPUT_LIMIT")
        # UTF-8 byte allowance plus bounded framing overhead is a deliberately
        # conservative estimate, not a provider billing guarantee or tokenizer.
        input_allowance = len(raw)+2048
        reserved = input_allowance*config.model_input_microusd_per_token + config.model_max_output_tokens*config.model_output_microusd_per_token
        try:
            self.slots.acquire_nowait()
        except anyio.WouldBlock:
            raise ModelError("MODEL_BUSY") from None
        try:
            budget.reserve(reserved)
            with anyio.fail_after(budget.remaining()):
                try:
                    async with self.client.stream("POST", ENDPOINT, content=raw,
                        headers={"Authorization":"Bearer "+config.openai_api_key.get_secret_value(),
                            "Content-Type":"application/json", "Accept":"application/json"}) as response:
                        if response.status_code==429:
                            raise ModelError("MODEL_THROTTLED")
                        if response.status_code in (401, 403):
                            raise ModelError("MODEL_ACCESS_DENIED")
                        if response.status_code!=200:
                            raise ModelError("MODEL_UNAVAILABLE")
                        data = bytearray()
                        async for chunk in response.aiter_bytes():
                            data.extend(chunk)
                            if len(data)>MAX_RESPONSE_BYTES:
                                raise ModelError("MODEL_RESPONSE_LIMIT")
                        result = self.parse(bytes(data), tools, input_allowance)
                        budget.remaining()
                except httpx.TimeoutException:
                    raise ModelError("MODEL_TIMEOUT") from None
                except httpx.HTTPError:
                    raise ModelError("MODEL_UNAVAILABLE") from None
            budget.cost += result.estimated_cost_microusd-reserved
            budget.input_tokens += result.input_tokens
            budget.output_tokens += result.output_tokens
            return result
        except TimeoutError:
            raise ModelError("MODEL_TIMEOUT") from None
        finally:
            self.slots.release()

    def parse(self, raw, tools, input_allowance):
        try:
            data = closed_json(raw)
            if data.get("status")!="completed":
                raise ModelError("MODEL_INCOMPLETE")
            usage = data["usage"]
            incoming, outgoing = usage["input_tokens"], usage["output_tokens"]
            if type(incoming) is not int or type(outgoing) is not int or not 0<=incoming<=input_allowance or not 0<=outgoing<=self.settings.model_max_output_tokens:
                raise ModelError("MODEL_USAGE_INVALID")
            definitions = {tool.name:tool for tool in tools}
            output = data["output"]
            if not isinstance(output, list) or len(output)>16:
                raise ModelError("MODEL_INVALID_RESPONSE")
            calls = []
            for item in output:
                if item["type"]=="reasoning":
                    continue
                if item["type"]!="function_call" or item.get("status") not in (None, "completed"):
                    # Text/refusal is never accepted as an authoritative result.
                    raise ModelError("MODEL_UNSUPPORTED_OUTPUT")
                if item["name"] not in definitions or not isinstance(item["arguments"], str) or len(item["arguments"].encode("utf-8"))>8192:
                    raise ModelError("MODEL_INVALID_TOOL")
                args = closed_json(item["arguments"])
                definition = definitions[item["name"]]
                schema = definition.schema()["parameters"]
                if not isinstance(args, dict) or set(args)!=set(schema["properties"]):
                    raise ModelError("MODEL_INVALID_ARGUMENTS")
                # Validate JSON mode strictly: ISO dates are allowed; strings do not
                # silently become numbers and model-supplied authority is rejected.
                validated = definition.arguments.model_validate_json(json.dumps(args), strict=True)
                complete_arguments(validated)
                calls.append(ToolCall(item["name"], validated))
            if len(calls)!=1:
                raise ModelError("MODEL_INVALID_TOOL_COUNT")
            cost = incoming*self.settings.model_input_microusd_per_token + outgoing*self.settings.model_output_microusd_per_token
            return ModelDecision(tuple(calls), incoming, outgoing, cost)
        except ModelError:
            raise
        except (ValueError, TypeError, KeyError, AttributeError, RecursionError, ValidationError):
            raise ModelError("MODEL_INVALID_RESPONSE") from None


def build_model(settings, **kwargs) -> StructuredModel:
    if settings.model_provider=="gemini":
        from .gemini_adapter import GeminiFunctions
        return GeminiFunctions(settings,**kwargs)
    return OpenAIResponses(settings, **kwargs)
