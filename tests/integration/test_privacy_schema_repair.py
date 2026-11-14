"""Compatibility repair is additive and preserves existing privacy choices."""
from pathlib import Path
import importlib.util
from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import text


def test_repair_missing_privacy_column_and_preserve_an_existing_preference(database,owners):
 path=Path(__file__).resolve().parents[2]/'db/migrations/versions/0022_repair_ai_privacy_column.py'
 spec=importlib.util.spec_from_file_location('privacy_repair',path);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
 with database['engine'].begin() as connection:
  connection.execute(text('ALTER TABLE moneylens.user_state DROP COLUMN allow_ai_payment_descriptions'))
  with Operations.context(MigrationContext.configure(connection)):
   module.upgrade()
   assert connection.execute(text('SELECT bool_and(NOT allow_ai_payment_descriptions) FROM moneylens.user_state')).scalar() is True
   connection.execute(text('UPDATE moneylens.user_state SET allow_ai_payment_descriptions=true WHERE tenant_id=:tenant AND owner_user_id=:owner'),dict(tenant=owners[0][0],owner=owners[0][1]))
   module.upgrade()
   assert connection.execute(text('SELECT allow_ai_payment_descriptions FROM moneylens.user_state WHERE tenant_id=:tenant AND owner_user_id=:owner'),dict(tenant=owners[0][0],owner=owners[0][1])).scalar() is True
