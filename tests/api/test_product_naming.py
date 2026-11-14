from pathlib import Path


ROOT=Path(__file__).parents[2]
USER_FACING=(
    ROOT/"apps/web/app",
    ROOT/"apps/web/components",
    ROOT/"complete-ui/src",
)
TECHNICAL_FILES={"private-session.ts","next.config.ts"}


def test_user_facing_strings_use_money_coach():
    matches=[]
    for folder in USER_FACING:
        for path in folder.rglob("*"):
            if not path.is_file() or path.name in TECHNICAL_FILES:
                continue
            if path.suffix not in {".ts",".tsx",".js",".jsx",".json",".html"}:
                continue
            text=path.read_text(encoding="utf-8")
            if "MoneyLens" in text:
                matches.append(str(path.relative_to(ROOT)))
    assert matches==[]
