from types import SimpleNamespace
from uuid import UUID

import pytest
from pydantic import ValidationError

from app.database import TrustedScope
from app.identity import AuthError
from app.insight_records import DismissInsightV1,RefreshInsightsV1
from app.insight_store import InsightStore
from app.insight_worker import run_insights_once


@pytest.mark.parametrize("key",["","contains spaces","x"*129,"key/other",123,True])
def test_refresh_keys_are_bounded_explicit_and_not_an_arbitrary_action(key):
    with pytest.raises(ValidationError): RefreshInsightsV1(key=key)


@pytest.mark.parametrize("version",[0,True,"1",2**53])
def test_dismiss_requires_an_exact_expected_version(version):
    with pytest.raises(ValidationError): DismissInsightV1(key="dismiss-1",expected_insight_version=version)


@pytest.mark.parametrize("extra",[{"owner_user_id":str(UUID(int=1))},{"amount_minor":1},{"policy":{}},{"candidate":{}},{"status":"active"}])
def test_command_arguments_cannot_supply_source_facts_authority_or_reactivate_insights(extra):
    with pytest.raises(ValidationError): RefreshInsightsV1(key="refresh",**extra)
    with pytest.raises(ValidationError): DismissInsightV1(key="dismiss",expected_insight_version=1,**extra)


def test_forged_internal_commands_and_unbounded_pages_fail_before_any_connection():
    user=SimpleNamespace(scope=TrustedScope(UUID(int=1),UUID(int=2)))
    repository=InsightStore(None,user)
    with pytest.raises(AuthError,match="INVALID_INSIGHT_COMMAND"):
        repository.dismiss(UUID(int=3),DismissInsightV1.model_construct(key="forged",expected_insight_version=True))
    with pytest.raises(AuthError,match="INVALID_INSIGHT_COMMAND"):
        repository.request_refresh(RefreshInsightsV1.model_construct())
    for limit in (True,0,101):
        with pytest.raises(AuthError,match="INVALID_INSIGHT_PAGE"): repository.page(None,limit=limit)


@pytest.mark.parametrize("age",[True,0,169,"24",1.5])
def test_worker_source_age_is_validated_before_opening_a_database(age):
    with pytest.raises(ValueError):
        run_insights_once("not-a-real-database",TrustedScope(UUID(int=1),UUID(int=2)),maximum_age_hours=age)
