"""Offline configuration check or explicitly requested live check; billing policy always applies."""
import argparse
import asyncio
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend/api"))

from typing import Literal
from pydantic import ValidationError
from app.contracts import Contract
from app.model_adapter import ModelError, ModelInput, ToolDefinition, TurnBudget, build_model
from app.settings import Settings


class Language(Contract):
    language: Literal["en", "et", "fi", "sv"]


async def check(*,offline=False):
    try:
        settings = Settings(_env_file=ROOT / ".env")
    except ValidationError:
        print("Model configuration is invalid. Review .env; secret values were not printed.")
        return 1
    if offline:
        print(f"Model: {settings.model_name}; enabled={settings.model_enabled}; billing_policy={settings.model_billing_policy}; key_present={bool(settings.openai_api_key)}")
        print("No network request made. Free-only policy blocks this provider; complimentary quota is not a zero-charge guarantee.")
        return 0
    model = build_model(settings)
    try:
        result = await model.decide(ModelInput("Choose the language of the user's greeting using the language tool.", "Tere!"),
            (ToolDefinition("language", "Identify the greeting language.", Language),), TurnBudget(settings))
        if result.calls[0].arguments.language!="et":
            raise ModelError("MODEL_SMOKE_UNEXPECTED_LANGUAGE")
        print(f"Live model check passed: {settings.model_name}; input_tokens={result.input_tokens}; "
            f"output_tokens={result.output_tokens}; estimated_cost_microusd={result.estimated_cost_microusd}")
    except ModelError as exc:
        print(f"Live model check unavailable: {exc.code}")
        return 1
    finally:
        await model.close()
    return 0


if __name__=="__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--check-config",action="store_true",help="Inspect nonsecret settings offline; never make a provider call")
    mode.add_argument("--live",action="store_true",help="Request one smoke check; does not override free-only billing policy")
    args = parser.parse_args()
    raise SystemExit(asyncio.run(check(offline=args.check_config)))
