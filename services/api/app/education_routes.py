"""Public static education; personalized financial queries remain separately authorized."""
from fastapi import APIRouter

from .education import EducationExplanationV1,EducationLocale,TopicId,explain

router=APIRouter()


@router.get("/v1/public/education",response_model=EducationExplanationV1)
def explanation(topic:TopicId="observed_spending",locale:EducationLocale="en"):
    return explain(topic,locale)
