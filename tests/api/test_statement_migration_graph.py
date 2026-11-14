"""Migration filenames are labels; only revision IDs and their edges define the graph."""
from pathlib import Path
from alembic.config import Config
from alembic.script import ScriptDirectory


def test_statement_revisions_have_one_integrated_head():
    root=Path(__file__).resolve().parents[2]
    graph=ScriptDirectory.from_config(Config(str(root/'backend/db/alembic.ini')))
    assert graph.get_heads()==['0029_automatic_classification']
    assert graph.get_revision('0029_automatic_classification').down_revision=='0028_merge_identity_statements'
    assert graph.get_revision('0028_merge_identity_statements').down_revision==(
        '0027_statement_file_provenance','0025_identity_self_signup')
    assert graph.get_revision('0025_identity_self_signup').down_revision=='0024_statement_staging'
    assert graph.get_revision('0026_merge_statement_branches').down_revision==(
        '0025_statement_provenance','0025_statement_formats')
    revisions=list(graph.walk_revisions())
    assert len({r.revision for r in revisions})==len(revisions)
    assert graph.get_revision('0025_statement_provenance').down_revision=='0024_statement_staging'
    assert graph.get_revision('0025_statement_formats').down_revision=='0024_statement_staging'
