"""Authored, bounded learning notes; no financial facts or model input are required."""
from functools import lru_cache
import json
from pathlib import Path
from typing import Annotated,Literal

from pydantic import Field

from .contracts import Contract
from .identity import AuthError

EducationLocale=Literal["en","fi","sv"]
TopicId=Annotated[str,Field(pattern=r"^[a-z][a-z0-9_]{1,39}$")]
Text=Annotated[str,Field(min_length=1,max_length=600)]
SOURCE=Path(__file__).resolve().parents[3]/"fixtures/public/education.v1.json"
TOPICS=("observed_spending","spending_baskets","cash_flow","protected_money","shared_surplus",
    "opportunity_cost","scenario_assumptions","population_mean")


class EducationTextV1(Contract):
    title: Annotated[str,Field(min_length=1,max_length=120)]
    summary: Text
    details: list[Text] = Field(min_length=1,max_length=3)
    practical_choice: Text


class EducationTopicV1(Contract):
    id: TopicId
    title: Annotated[str,Field(min_length=1,max_length=120)]


class EducationExplanationV1(EducationTextV1):
    content_version: Literal["education.v1"] = "education.v1"
    audience: Literal["general_education"] = "general_education"
    locale: EducationLocale
    topic: TopicId
    topics: list[EducationTopicV1] = Field(min_length=1,max_length=24)


@lru_cache(maxsize=1)
def education_content():
    if SOURCE.stat().st_size>65536: raise ValueError("Learning notes exceed their content budget")
    raw=SOURCE.read_bytes()
    if len(raw)>65536: raise ValueError("Learning notes exceed their content budget")
    content=json.loads(raw.decode("utf-8"))
    if set(content)!={"version","locales"} or content["version"]!="education.v1" or set(content["locales"])!={"en","fi","sv"}:
        raise ValueError("Unknown learning-note contract")
    result={}
    for locale,topics in content["locales"].items():
        if set(topics)!=set(TOPICS): raise ValueError("Learning notes must cover the same topics in each language")
        result[locale]={topic:EducationTextV1.model_validate(text) for topic,text in topics.items()}
    return result


def explain(topic,locale="en"):
    if locale not in ("en","fi","sv"): raise AuthError("INVALID_REQUEST",422)
    try: content=education_content()[locale]
    except (OSError,ValueError,KeyError,TypeError): raise AuthError("EDUCATION_UNAVAILABLE",503) from None
    if topic not in content: raise AuthError("NOT_FOUND",404)
    return EducationExplanationV1(**content[topic].model_dump(mode="python"),locale=locale,topic=topic,
        topics=[EducationTopicV1(id=key,title=content[key].title) for key in TOPICS])
