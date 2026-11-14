from copy import deepcopy
import importlib.util
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("contract_gate",ROOT / "scripts/check_contracts.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

BASE = {"components":{"schemas":{"Money":{"type":"integer","maximum":100}}},"paths":{
    "/v1/example":{"get":{"operationId":"example","parameters":[],"responses":{"200":{"content":{"application/json":{"schema":{"$ref":"#/components/schemas/Money"}}}}}}}}}


def test_additive_operations_components_and_optional_parameters_are_allowed():
    current = deepcopy(BASE)
    current["paths"]["/v1/new"] = {"get":{"responses":{}}}
    current["components"]["schemas"]["New"] = {"type":"string"}
    current["paths"]["/v1/example"]["get"]["parameters"] = [{"in":"query","name":"optional","required":False,"schema":{"type":"string"}}]
    assert module.compatibility(BASE,current) == []


@pytest.mark.parametrize("change", ["remove_route","rename_client_method","change_money","require_parameter","change_response","require_auth","broken_ref"])
def test_breaking_contract_edits_are_rejected(change):
    current = deepcopy(BASE)
    operation = current["paths"]["/v1/example"]["get"]
    if change == "remove_route":
        current["paths"] = {}
    elif change == "rename_client_method":
        operation["operationId"] = "different"
    elif change == "change_money":
        current["components"]["schemas"]["Money"]["type"] = "number"
    elif change == "require_parameter":
        operation["parameters"] = [{"in":"header","name":"new","required":True}]
    elif change == "change_response":
        operation["responses"] = {}
    elif change == "require_auth":
        operation["security"] = [{"NewAuth":[]}]
    else:
        current["components"]["schemas"]["New"] = {"$ref":"#/components/schemas/Missing"}
    assert module.compatibility(BASE,current)


def test_documentation_edits_do_not_change_contract_semantics():
    current = deepcopy(BASE)
    current["components"]["schemas"]["Money"]["description"] = "Updated explanation"
    assert module.compatibility(BASE,current) == []


def test_properties_and_defaults_named_description_are_still_semantic():
    baseline = deepcopy(BASE)
    baseline["components"]["schemas"]["Named"] = {"type":"object","properties":{"description":{"type":"string"}},"default":{"description":"original"}}
    current = deepcopy(baseline)
    current["components"]["schemas"]["Named"]["properties"] = {}
    assert module.compatibility(baseline,current)
    current = deepcopy(baseline)
    current["components"]["schemas"]["Named"]["default"]["description"] = "changed"
    assert module.compatibility(baseline,current)


def test_generated_private_operations_document_cookie_and_csrf_security():
    from app.main import create_app
    from app.settings import Settings
    config = Settings(environment="test",auth_enabled=True,database_url="postgresql://unused/db",
        auth_database_url="postgresql://unused/db",session_secret="schema-only-test-key-with-32-characters")
    schema = create_app(config).openapi()
    assert schema["paths"]["/v1/accounts"]["get"]["security"] == [{"SessionCookie":[]}]
    assert schema["components"]["securitySchemes"]["SessionCookie"]["name"] == "moneylens_session"
    assert "X-CSRF-Token" in {param["name"] for param in schema["paths"]["/v1/auth/logout"]["post"]["parameters"]}
    assert "security" not in schema["paths"]["/v1/auth/demo"]["post"]
