"""Run from repository root; prints sanitized readiness JSON only.

Default: offline. --directory: signed GET /application and /aspsps only.
Does not enable Live Banking, create consent, read accounts or import records.
"""
import argparse
import json
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "services" / "api"))

from app.live_banking_preflight import preflight
from app.settings import Settings


def read_runtime_environment(env_file: Path):
    """Use the API launcher's Node parser, not a different dotenv dialect.

    Secrets cross only a captured local pipe. Never echo child output/errors.
    Existing process variables retain Node's normal precedence.
    """
    result = subprocess.run([
        "node", f"--env-file-if-exists={env_file}", "-e",
        "process.stdout.write(JSON.stringify(Object.fromEntries("
        "Object.entries(process.env).filter(([name])=>name.startsWith('MONEYLENS_')))))",
    ], cwd=ROOT, capture_output=True, text=True, check=True, timeout=10)
    return json.loads(result.stdout)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", action="store_true", help="Allow provider metadata GETs only")
    args = parser.parse_args()
    try:
        values = read_runtime_environment(ROOT / ".env")
        settings = Settings(**{
            name.removeprefix("MONEYLENS_").lower(): value
            for name, value in values.items() if name.startswith("MONEYLENS_")
        })
        report = preflight(settings, directory=args.directory)
    except Exception:
        # Pydantic/cryptography exceptions can contain sensitive input values.
        print(json.dumps({"error": "BANK_PREFLIGHT_FAILED_DETAILS_WITHHELD"}))
        return 1
    print(json.dumps(report, indent=2))
    return 0 if report["configuration_valid"] and not report.get("error") else 1


if __name__ == "__main__":
    sys.exit(main())
