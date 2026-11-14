from pathlib import Path


ROOT=Path(__file__).parents[2]
USER_FACING=(
    ROOT/"frontend/web/app",
    ROOT/"frontend/web/components",
    ROOT/"frontend/coach/src",
)
TECHNICAL_FILES={"private-session.ts","next.config.ts"}


def test_user_facing_strings_use_money_coach():
    matches=[]
    for folder in USER_FACING:
        assert folder.is_dir(), f"Missing application directory: {folder}"
        for path in folder.rglob("*"):
            if not path.is_file() or path.name in TECHNICAL_FILES:
                continue
            if path.suffix not in {".ts",".tsx",".js",".jsx",".json",".html"}:
                continue
            text=path.read_text(encoding="utf-8")
            if "MoneyLens" in text:
                matches.append(str(path.relative_to(ROOT)))
    assert matches==[]
