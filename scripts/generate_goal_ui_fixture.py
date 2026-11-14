"""Publish deterministic UI transport facts using the actual goal progress engine."""
from datetime import datetime,timezone
import json
from pathlib import Path
import sys
from uuid import UUID

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/"services/api"))
from app.goals import GoalSnapshotV1,GoalViewV1,goal_progress

now=datetime(2026,11,5,10,tzinfo=timezone.utc)
base=dict(id=UUID("00000000-0000-0000-0000-000000000311"),name="Emergency fund",target_minor=10000,
    currency="EUR",deadline="2026-12-31",priority=2,state="active",version=1,created_at=now,updated_at=now)
result={"clock":now.isoformat()}
for name,reserved,changes in [("empty",0,{}),("reserved",5000,{"version":2}),("paused",5000,{"version":3,"state":"paused"}),
    ("revised",5000,{"version":3,"target_minor":15000}),("removed",0,{"version":4,"state":"removed"})]:
    goal=GoalSnapshotV1(**{**base,**changes})
    result[name]=GoalViewV1(**goal.model_dump(),as_of=now,collection_version=goal.version+1,data_version=1,plan_version=3,
        progress=goal_progress(goal,reserved=reserved,consistent=True,now=now)).model_dump(mode="json")
target=ROOT/"fixtures/synthetic/goals-ui.v1.json"
target.write_text(json.dumps(result,indent=2,sort_keys=True)+"\n",encoding="utf-8",newline="\n")
print("Exported fixtures/synthetic/goals-ui.v1.json")
