"""Native Gemini interpretation only; no ledger, account lookup or execution access."""
import json

import anyio
import httpx
from pydantic import ValidationError

from .model_adapter import (MAX_RESPONSE_BYTES,MAX_TOOL_DEFINITIONS,ModelInput,ModelError,
    ModelDecision,OpenAIResponses,ToolCall,closed_json,complete_arguments)

GEMINI_MODEL="gemini-3.5-flash"
GEMINI_ENDPOINT="https://generativelanguage.googleapis.com/v1beta/models/"+GEMINI_MODEL+":generateContent"


class GeminiFunctions(OpenAIResponses):
    """Shares concurrency/deadline and usage bounds with the existing interpreter."""
    async def decide(self,request,tools,budget):
        config=self.settings
        if not config.model_enabled or not config.gemini_api_key:
            raise ModelError("MODEL_NOT_CONFIGURED")
        if config.model_billing_policy!="paid_allowed":
            raise ModelError("MODEL_FREE_ONLY_UNAVAILABLE")
        if config.model_name!=GEMINI_MODEL:
            raise ModelError("MODEL_NOT_CONFIGURED")
        if not isinstance(request,ModelInput) or not isinstance(request.question,str) or not request.question.strip() or not isinstance(request.instructions,str):
            raise ModelError("MODEL_INVALID_INPUT")
        try:question_size=len(request.question.encode("utf-8"));request.instructions.encode("utf-8")
        except UnicodeError:raise ModelError("MODEL_INVALID_INPUT") from None
        if question_size>8192 or not 1<=len(tools)<=MAX_TOOL_DEFINITIONS or len({tool.name for tool in tools})!=len(tools):
            raise ModelError("MODEL_INPUT_LIMIT")
        declarations=[]
        for tool in tools:
            schema=tool.schema()
            declarations.append(dict(name=tool.name,description=tool.description,parametersJsonSchema=schema["parameters"]))
        payload={"systemInstruction":{"parts":[{"text":request.instructions}]},
            "contents":[{"role":"user","parts":[{"text":request.question}]}],
            "tools":[{"functionDeclarations":declarations}],
            "toolConfig":{"functionCallingConfig":{"mode":"ANY"}},
            "generationConfig":{"maxOutputTokens":config.model_max_output_tokens,"thinkingConfig":{"thinkingLevel":"MINIMAL"}}}
        raw=json.dumps(payload,ensure_ascii=False,separators=(",",":")).encode("utf-8")
        if len(raw)>config.model_max_input_bytes:raise ModelError("MODEL_INPUT_LIMIT")
        input_allowance=len(raw)+2048
        reserved=input_allowance*config.model_input_microusd_per_token+config.model_max_output_tokens*config.model_output_microusd_per_token
        try:self.slots.acquire_nowait()
        except anyio.WouldBlock:raise ModelError("MODEL_BUSY") from None
        try:
            budget.reserve(reserved)
            with anyio.fail_after(budget.remaining()):
                try:
                    async with self.client.stream("POST",GEMINI_ENDPOINT,content=raw,
                        headers={"x-goog-api-key":config.gemini_api_key.get_secret_value(),"Content-Type":"application/json","Accept":"application/json"}) as response:
                        if response.status_code==429:raise ModelError("MODEL_THROTTLED")
                        if response.status_code in (401,403):raise ModelError("MODEL_ACCESS_DENIED")
                        if response.status_code!=200:raise ModelError("MODEL_UNAVAILABLE")
                        data=bytearray()
                        async for chunk in response.aiter_bytes():
                            data.extend(chunk)
                            if len(data)>MAX_RESPONSE_BYTES:raise ModelError("MODEL_RESPONSE_LIMIT")
                        result=self.parse(bytes(data),tools,input_allowance)
                        budget.remaining()
                except httpx.TimeoutException:raise ModelError("MODEL_TIMEOUT") from None
                except httpx.ConnectError as error:
                    # Stable diagnostic identifies OS-level egress denial, without provider bodies.
                    cause=error
                    while cause is not None:
                        if getattr(cause,"errno",None) in (13,10013):raise ModelError("MODEL_NETWORK_ACCESS_DENIED") from None
                        cause=cause.__cause__ or cause.__context__
                    raise ModelError("MODEL_UNAVAILABLE") from None
                except httpx.HTTPError:raise ModelError("MODEL_UNAVAILABLE") from None
            budget.cost+=result.estimated_cost_microusd-reserved
            budget.input_tokens+=result.input_tokens;budget.output_tokens+=result.output_tokens
            return result
        except TimeoutError:raise ModelError("MODEL_TIMEOUT") from None
        finally:self.slots.release()

    def parse(self,raw,tools,input_allowance):
        try:
            data=closed_json(raw)
            candidates=data.get("candidates")
            if not isinstance(candidates,list) or len(candidates)!=1:raise ModelError("MODEL_INVALID_RESPONSE")
            candidate=candidates[0]
            if candidate.get("finishReason")!="STOP":raise ModelError("MODEL_INCOMPLETE")
            parts=candidate["content"]["parts"]
            if not isinstance(parts,list) or len(parts)>16:raise ModelError("MODEL_INVALID_RESPONSE")
            calls=[part["functionCall"] for part in parts if isinstance(part,dict) and "functionCall" in part]
            if len(calls)!=1:raise ModelError("MODEL_INVALID_TOOL_COUNT")
            if any(not isinstance(part,dict) or ("functionCall" not in part and part.get("thought") is not True) for part in parts):
                raise ModelError("MODEL_UNSUPPORTED_OUTPUT")
            call=calls[0];definitions={tool.name:tool for tool in tools}
            if call["name"] not in definitions or not isinstance(call.get("args"),dict):raise ModelError("MODEL_INVALID_TOOL")
            definition=definitions[call["name"]];args=call["args"]
            if set(args)!=set(definition.schema()["parameters"]["properties"]):raise ModelError("MODEL_INVALID_ARGUMENTS")
            encoded=json.dumps(args,separators=(",",":"))
            if len(encoded.encode("utf-8"))>8192:raise ModelError("MODEL_INVALID_ARGUMENTS")
            validated=definition.arguments.model_validate_json(encoded,strict=True);complete_arguments(validated)
            usage=data["usageMetadata"];incoming,total=usage["promptTokenCount"],usage["totalTokenCount"]
            if type(incoming) is not int or type(total) is not int or not 0<=incoming<=input_allowance or not incoming<total<=incoming+self.settings.model_max_output_tokens:
                raise ModelError("MODEL_USAGE_INVALID")
            outgoing=total-incoming
            cost=incoming*self.settings.model_input_microusd_per_token+outgoing*self.settings.model_output_microusd_per_token
            return ModelDecision((ToolCall(call["name"],validated),),incoming,outgoing,cost)
        except ModelError:raise
        except (ValueError,TypeError,KeyError,AttributeError,RecursionError,ValidationError):raise ModelError("MODEL_INVALID_RESPONSE") from None
