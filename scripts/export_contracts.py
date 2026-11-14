"""Export API and domain schemas using the same Pydantic definitions as runtime."""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "services/api"))

from pydantic.json_schema import models_json_schema
from app.contracts import CONTRACTS
from app.bank_adapter import (BankAccountV1, BankAuthorizationV1, BankBalanceV1, BankCapabilitiesV1,
    BankGrantV1, BankRevocationV1, BankTransactionPageV1, BankTransactionV1)
from app.main import create_app
from app.settings import Settings
from app.category_crosswalk import CategoryMappingCoverageV1

api = create_app(Settings(environment="test", allow_demo=True,auth_enabled=True,
    database_url="postgresql://contracts.invalid/db",auth_database_url="postgresql://identity.invalid/db",
    session_secret="schema-export-only-not-a-runtime-secret"))
schema = api.openapi()
bank_contracts = [BankAccountV1,BankAuthorizationV1,BankBalanceV1,BankCapabilitiesV1,BankGrantV1,
    BankRevocationV1,BankTransactionPageV1,BankTransactionV1]
_, domains = models_json_schema([(model, "validation") for model in [*CONTRACTS,*bank_contracts,CategoryMappingCoverageV1]], ref_template="#/components/schemas/{model}")
schema.setdefault("components", {}).setdefault("schemas", {}).update(domains["$defs"])
target = ROOT / "packages/contracts/openapi.json"
target.parent.mkdir(parents=True, exist_ok=True)
target.write_text(json.dumps(schema, indent=2, sort_keys=True) + "\n", encoding="utf-8",newline="\n")
print("Exported packages/contracts/openapi.json")
