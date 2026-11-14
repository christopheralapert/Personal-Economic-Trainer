from dataclasses import replace
from uuid import uuid4

import pytest

from app.database import TrustedScope
from app.identity import AuthError
from app.scoped_keys import CursorCodec,DataScope


def scope():
    return DataScope(TrustedScope(uuid4(),uuid4()),1,2,3,(uuid4(),),"EUR",{"start":"2026-10-01"})


@pytest.mark.parametrize("field,value",[("permission_version",2),("data_version",4),("plan_version",5),("currency","USD"),("filters",{"start":"2026-09-01"}),("account_ids",(uuid4(),))])
def test_scope_dimensions_cannot_share_private_keys(field,value):
    first = scope()
    assert first.key("analysis.v1") != replace(first,**{field:value}).key("analysis.v1")


def test_cursors_are_encrypted_expire_and_do_not_authorize_foreign_scope():
    original = scope()
    clock = [1000]
    codec = CursorCodec("test-only-key",clock=lambda:clock[0])
    position = {"id":str(uuid4()),"booked_on":"2026-10-01"}
    token = codec.encode(original,position)
    assert position["id"] not in token and position["booked_on"] not in token
    assert codec.decode(token,original) == position
    with pytest.raises(AuthError):
        codec.decode(token,scope())
    clock[0] += 901
    with pytest.raises(AuthError) as error:
        codec.decode(token,original)
    assert error.value.code == "CURSOR_EXPIRED"
