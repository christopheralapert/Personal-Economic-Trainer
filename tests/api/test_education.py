import json

import pytest
from fastapi.testclient import TestClient

from app import education
from app.identity import AuthError
from app.main import create_app
from app.settings import Settings


def test_all_topics_have_explicit_locales_and_response_copies():
    for locale in ("en", "fi", "sv"):
        for topic in education.TOPICS:
            value = education.explain(topic, locale)
            assert value.topic == topic and value.locale == locale
            assert value.audience == "general_education"
            assert [item.id for item in value.topics] == list(education.TOPICS)
            assert value.summary and value.details and value.practical_choice
    first = education.explain("cash_flow", "fi")
    first.details.clear()
    first.topics[0].title = "changed by caller"
    again = education.explain("cash_flow", "fi")
    assert again.details and again.topics[0].title != "changed by caller"
    assert again.title != education.explain("cash_flow", "en").title


@pytest.mark.parametrize("corrupt", [b"{", b"x" * 65537, json.dumps({"version":"education.v1","locales":{}}).encode()])
def test_invalid_learning_bundle_fails_without_returning_partial_content(tmp_path, monkeypatch, corrupt):
    source = tmp_path / "notes.json"
    source.write_bytes(corrupt)
    monkeypatch.setattr(education, "SOURCE", source)
    education.education_content.cache_clear()
    try:
        with pytest.raises(AuthError) as failure:
            education.explain("cash_flow")
        assert failure.value.code == "EDUCATION_UNAVAILABLE"
    finally:
        education.education_content.cache_clear()


def test_public_learning_is_static_bounded_and_does_not_require_identity():
    client = TestClient(create_app(Settings(environment="test", auth_enabled=False)))
    response = client.get("/v1/public/education", params={"topic":"protected_money","locale":"sv"})
    assert response.status_code == 200
    assert response.headers["cache-control"] == "private, no-store"
    assert response.json()["locale"] == "sv"
    assert response.json()["audience"] == "general_education"
    assert client.get("/v1/public/education", params={"topic":"unknown_topic"}).status_code == 404
    assert client.get("/v1/public/education", params={"locale":"et"}).status_code == 422
    assert client.get("/v1/public/education", params={"topic":"x" * 100}).status_code == 422
    assert client.post("/v1/public/education", json={}).status_code == 405
    assert client.get("/v1/public/education").json() == education.explain("observed_spending").model_dump(mode="json")
