"""Meaningful parser boundaries: byte resume, financial strings and bounded reads."""
import csv
from datetime import datetime,timezone
import hashlib
import io
from types import SimpleNamespace
import time

import pytest

from app import import_csv as native

NOW=datetime(2026,11,5,tzinfo=timezone.utc)
MANIFEST=SimpleNamespace(source_customer_ref="synthetic-1",currency="EUR",
    claimed_from=native.date(2026,10,1),claimed_to_exclusive=native.date(2026,11,1))


def transaction(**updates):
    return dict(source_customer_ref="synthetic-1",account_ref="daily",source_id="one",revision="1",amount_minor="-125",
        currency="EUR",booked_on="2026-10-15",value_on="",observed_at="2026-11-04T10:00:00Z",status="booked",
        merchant="Cafe",category="coffee",basket="everyday",economic_flow="expense",related_account_ref="",related_source_id="",**updates)


def encode(rows,*,ending="\n",header=None):
    body=io.StringIO(newline="")
    writer=csv.writer(body,lineterminator=ending);writer.writerow(header or native.COLUMNS["transactions"])
    for row in rows: writer.writerow([row[key] for key in native.COLUMNS["transactions"]])
    return body.getvalue().encode("utf-8")


def parse(raw,*,offset=0,ordinal=0):
    return native.parse_chunk(io.BytesIO(raw[offset:]),role="transactions",offset=offset,ordinal=ordinal,
        size_bytes=len(raw),manifest=MANIFEST,as_of=NOW,deadline=time.monotonic()+10)


def test_quoted_multiline_utf8_crlf_resume_preserves_exact_raw_byte_ranges(monkeypatch):
    monkeypatch.setattr(native,"CHUNK_ROWS",1)
    first=transaction();first["merchant"]="Kohvik \u00e4\nCounter"
    second=transaction();second["source_id"]="two"
    raw=b"\xef\xbb\xbf"+encode([first,second],ending="\r\n")
    one=parse(raw);two=parse(raw,offset=one.end_offset,ordinal=1)
    assert one.rows[0].payload["merchant"]==first["merchant"]
    assert one.rows[0].payload["amount_minor"]==-125
    assert two.rows[0].payload["source_id"]=="two" and two.rows[0].ordinal==2
    for row in [*one.rows,*two.rows]:
        assert row.sha256==hashlib.sha256(raw[row.byte_start:row.byte_end]).hexdigest()
    assert two.end_offset==len(raw)
    assert parse(raw,offset=two.end_offset,ordinal=2).complete


def test_no_rounding_float_scientific_or_unsafe_money_is_accepted():
    rows=[]
    for index,value in enumerate(("12.50","1e3","NaN","+125","9007199254740992","-0","\u2212125")):
        row=transaction();row.update(source_id=f"bad-{index}",amount_minor=value);rows.append(row)
    valid=transaction();valid.update(source_id="valid",amount_minor="-9007199254740991");rows.append(valid)
    chunk=parse(encode(rows))
    assert len(chunk.rows)==8 and all(row.payload is None and row.fields==["amount_minor"] for row in chunk.rows[:-1])
    assert chunk.rows[-1].payload["amount_minor"]==-(2**53-1)


def test_source_customer_currency_booking_and_aware_time_are_checked():
    rows=[]
    for updates in ({"source_customer_ref":"other"},{"currency":"USD"},{"booked_on":"2026-11-01"},
            {"observed_at":"2026-11-04T10:00:00"},{"observed_at":"2026-11-04T10:00:00-00:00"},
            {"observed_at":"2026-11-06T10:00:00Z"}):
        row=transaction();row.update(updates);rows.append(row)
    chunk=parse(encode(rows))
    assert [row.reasons[0] for row in chunk.rows]==["source_customer_mismatch","currency_mismatch",
        "booking_outside_coverage","invalid_aware_instant","invalid_aware_instant","future_observation"]


def test_ambiguous_headers_encoding_quotes_and_oversized_records_fail_closed():
    header=encode([])
    sources=[(encode([],header=["owner_user_id"]),"import_csv_header_mismatch"),
        (header+b"\xff\n","import_csv_invalid_utf8"),(header+b'"unterminated\n',"import_csv_syntax"),
        (header+b'x'*(native.MAX_RECORD_BYTES+1)+b'\n',"import_csv_record_too_large")]
    for raw,code in sources:
        with pytest.raises(native.CsvSourceError) as error: parse(raw)
        assert error.value.code==code


def test_a_chunk_reads_only_a_bounded_prefix_of_a_virtual_million_row_source():
    header=encode([]);line=encode([transaction()])[len(header):]
    class VirtualSource:
        def __init__(self): self.read_bytes=0
        def read(self,size):
            assert 0<size<=native.READ_BYTES
            start=self.read_bytes;self.read_bytes+=size
            if start==0:
                remainder=size-len(header)
                return header+(line*((remainder//len(line))+1))[:remainder]
            index=(start-len(header))%len(line)
            return (line*((size//len(line))+2))[index:index+size]
    body=VirtualSource()
    chunk=native.parse_chunk(body,role="transactions",offset=0,ordinal=0,
        size_bytes=len(header)+1_000_000*len(line),manifest=MANIFEST,as_of=NOW,deadline=time.monotonic()+10)
    assert len(chunk.rows)==native.CHUNK_ROWS and not chunk.complete
    assert body.read_bytes<=native.CHUNK_BYTES+native.READ_BYTES
