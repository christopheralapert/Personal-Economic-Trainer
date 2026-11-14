"""Conservative published-v1 compatibility gate; additions are allowed, mutations are versioned."""
import argparse
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
METHODS = {"get","post","put","patch","delete","head","options","trace"}
ANNOTATIONS = {"description","title","example","examples","deprecated","externalDocs"}
NAMED_MAPS = {"properties","schemas","responses","headers","content","securitySchemes","paths"}


def semantic(value,context="keywords"):
    if context == "data":
        return value
    if isinstance(value,dict):
        result = {}
        for key,item in value.items():
            if context == "keywords" and key in ANNOTATIONS:
                continue
            child = "keywords"
            if context == "keywords" and key in NAMED_MAPS:
                child = "names"
            elif context == "keywords" and key in {"enum","const","default"}:
                child = "data"
            result[key] = semantic(item,child)
        return result
    if isinstance(value,list):
        return [semantic(item,context) for item in value]
    return value


def references(document):
    errors = []
    def walk(value):
        if isinstance(value,dict):
            if "$ref" in value:
                ref = value["$ref"]
                try:
                    if not ref.startswith("#/"):
                        raise KeyError()
                    target = document
                    for part in ref[2:].split("/"):
                        target = target[part.replace("~1","/").replace("~0","~")]
                except (KeyError,TypeError,AttributeError):
                    errors.append("Invalid or external schema reference: "+str(ref))
            for item in value.values():
                walk(item)
        elif isinstance(value,list):
            for item in value:
                walk(item)
    walk(document)
    return errors


def compatibility(baseline,current):
    errors = references(current)
    for section,items in baseline.get("components",{}).items():
        for name,old in items.items():
            new = current.get("components",{}).get(section,{}).get(name)
            if new is None or semantic(old) != semantic(new):
                errors.append(f"Published component changed: {section}/{name}")
    for path,methods in baseline.get("paths",{}).items():
        for method,old in methods.items():
            if method not in METHODS:
                continue
            new = current.get("paths",{}).get(path,{}).get(method)
            location = method.upper()+" "+path
            if new is None:
                errors.append("Published operation removed: "+location)
                continue
            for key in ("operationId","requestBody","security"):
                if semantic(old.get(key)) != semantic(new.get(key)):
                    errors.append(f"Published {key} changed: {location}")
            old_params = {(item["in"],item["name"]):item for item in old.get("parameters",[])}
            new_params = {(item["in"],item["name"]):item for item in new.get("parameters",[])}
            for key,value in old_params.items():
                if semantic(value) != semantic(new_params.get(key)):
                    errors.append(f"Published parameter changed: {location} {key}")
            for key,value in new_params.items():
                if key not in old_params and value.get("required"):
                    errors.append(f"New required parameter: {location} {key}")
            for status,value in old.get("responses",{}).items():
                if semantic(value) != semantic(new.get("responses",{}).get(status)):
                    errors.append(f"Published response changed: {location} {status}")
    return errors


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline",type=Path,default=ROOT / "packages/contracts/baselines/v1.openapi.json")
    parser.add_argument("--current",type=Path,default=ROOT / "packages/contracts/openapi.json")
    args = parser.parse_args(argv)
    errors = compatibility(json.loads(args.baseline.read_text(encoding="utf-8")),json.loads(args.current.read_text(encoding="utf-8")))
    if errors:
        print("\n".join(errors))
        return 1
    print("Published v1 operations/components are compatible; references resolve.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
