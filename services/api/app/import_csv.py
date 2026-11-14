"""Bounded native synthetic CSV parsing. Values remain staged source claims."""
import csv
from dataclasses import dataclass
from datetime import date,datetime,timedelta,timezone
import hashlib
import re
import time

MAX_MINOR=2**53-1
MAX_ROWS=10_000_000
MAX_RECORD_BYTES=65536
CHUNK_ROWS=250
CHUNK_BYTES=2*1024**2
READ_BYTES=65536
ROLES=("accounts","transactions","balances")
ROLE_LIMITS={"accounts":1000,"transactions":MAX_ROWS,"balances":10000}
PARSER_VERSION="moneylens.csv-parser.v1"
COLUMNS={
    "accounts":("source_customer_ref","account_ref","name","currency","account_type","coverage_from",
        "coverage_to_exclusive","expected_transactions","expected_net_minor"),
    "transactions":("source_customer_ref","account_ref","source_id","revision","amount_minor","currency",
        "booked_on","value_on","observed_at","status","merchant","category","basket","economic_flow",
        "related_account_ref","related_source_id"),
    "balances":("source_customer_ref","account_ref","source_id","amount_minor","currency","balance_kind",
        "pending_reflection","included_credit_minor","observed_at"),
}
REFERENCE=re.compile(r"[A-Za-z0-9._:-]{1,100}\Z",re.ASCII)
INTEGER=re.compile(r"(?:0|-?[1-9][0-9]{0,15})\Z",re.ASCII)
DAY=re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}\Z",re.ASCII)
INSTANT=re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,6})?(?:Z|[+-][0-9]{2}:[0-9]{2})\Z",re.ASCII)


class CsvSourceError(ValueError):
    def __init__(self,code):
        self.code=code
        super().__init__(code)


class InvalidRow(ValueError):
    def __init__(self,code,*fields):
        self.code,self.fields=code,list(fields)
        super().__init__(code)


@dataclass(frozen=True)
class SourceRow:
    ordinal: int
    byte_start: int
    byte_end: int
    sha256: str
    payload: dict | None
    reasons: list[str]
    fields: list[str]


@dataclass(frozen=True)
class CsvChunk:
    rows: list[SourceRow]
    end_offset: int
    complete: bool


class PhysicalLines:
    """CSV receives bounded physical lines and cannot buffer an unbounded record."""
    def __init__(self,body,offset,expected_size,deadline):
        self.body,self.offset,self.expected_size,self.deadline=body,offset,expected_size,deadline
        self.buffer=bytearray();self.eof=False
        self.reset_record()

    def reset_record(self):
        self.digest=hashlib.sha256();self.record_bytes=0

    def __iter__(self): return self

    def __next__(self):
        while True:
            if time.monotonic()>=self.deadline: raise TimeoutError("CSV chunk deadline exceeded")
            stop=self.buffer.find(b"\n")
            if stop>=0:
                raw=bytes(self.buffer[:stop+1]);del self.buffer[:stop+1]
                break
            if self.eof:
                if not self.buffer:
                    if self.offset!=self.expected_size: raise CsvSourceError("import_source_length_changed")
                    raise StopIteration
                raw=bytes(self.buffer);self.buffer.clear()
                break
            if self.record_bytes+len(self.buffer)>MAX_RECORD_BYTES: raise CsvSourceError("import_csv_record_too_large")
            chunk=self.body.read(READ_BYTES)
            if not chunk: self.eof=True
            else:
                self.buffer.extend(chunk)
                if self.offset+len(self.buffer)>self.expected_size: raise CsvSourceError("import_source_length_changed")
        self.record_bytes+=len(raw)
        if self.record_bytes>MAX_RECORD_BYTES: raise CsvSourceError("import_csv_record_too_large")
        start=self.offset;self.offset+=len(raw);self.digest.update(raw)
        try: return raw.decode("utf-8-sig" if start==0 else "utf-8",errors="strict")
        except UnicodeError: raise CsvSourceError("import_csv_invalid_utf8") from None


def integer(value,field,*,minimum=-MAX_MINOR,maximum=MAX_MINOR):
    if not INTEGER.fullmatch(value): raise InvalidRow("invalid_integer",field)
    result=int(value)
    if not minimum<=result<=maximum: raise InvalidRow("integer_out_of_range",field)
    return result


def reference(value,field):
    if not REFERENCE.fullmatch(value): raise InvalidRow("invalid_source_reference",field)
    return value


def day(value,field):
    try:
        if not DAY.fullmatch(value): raise ValueError()
        return date.fromisoformat(value)
    except ValueError: raise InvalidRow("invalid_date",field) from None


def choice(value,field,choices):
    if value not in choices: raise InvalidRow("invalid_choice",field)
    return value


def text(value,field,maximum):
    if not 1<=len(value)<=maximum or any((ord(c)<32 and c not in "\t\n\r") or c in "\x7f\ufeff" for c in value):
        raise InvalidRow("invalid_text",field)
    return value


def instant(value,field,as_of):
    try:
        if not INSTANT.fullmatch(value) or value.endswith("-00:00"): raise ValueError()
        result=datetime.fromisoformat(value.replace("Z","+00:00")).astimezone(timezone.utc)
    except (ValueError,OverflowError): raise InvalidRow("invalid_aware_instant",field) from None
    if result>as_of+timedelta(minutes=5): raise InvalidRow("future_observation",field)
    return result.isoformat()


def validate_row(role,cells,manifest,as_of):
    if len(cells)!=len(COLUMNS[role]): raise InvalidRow("invalid_column_count")
    row=dict(zip(COLUMNS[role],cells))
    if row["source_customer_ref"]!=manifest.source_customer_ref:
        raise InvalidRow("source_customer_mismatch","source_customer_ref")
    reference(row["account_ref"],"account_ref")
    if row["currency"]!=manifest.currency: raise InvalidRow("currency_mismatch","currency")
    if role=="accounts":
        text(row["name"],"name",200)
        choice(row["account_type"],"account_type",("current","savings","credit","restricted"))
        start=day(row["coverage_from"],"coverage_from");end=day(row["coverage_to_exclusive"],"coverage_to_exclusive")
        if (start,end)!=(manifest.claimed_from,manifest.claimed_to_exclusive):
            raise InvalidRow("coverage_mismatch","coverage_from","coverage_to_exclusive")
        row["expected_transactions"]=integer(row["expected_transactions"],"expected_transactions",minimum=0,maximum=MAX_ROWS)
        row["expected_net_minor"]=integer(row["expected_net_minor"],"expected_net_minor")
    else:
        reference(row["source_id"],"source_id")
        row["amount_minor"]=integer(row["amount_minor"],"amount_minor")
        row["observed_at"]=instant(row["observed_at"],"observed_at",as_of)
        if role=="balances":
            choice(row["balance_kind"],"balance_kind",("available","booked"))
            choice(row["pending_reflection"],"pending_reflection",("included","excluded","unknown"))
            row["included_credit_minor"]=integer(row["included_credit_minor"],"included_credit_minor",minimum=0)
        else:
            row["revision"]=integer(row["revision"],"revision",minimum=1)
            booking=day(row["booked_on"],"booked_on")
            if not manifest.claimed_from<=booking<manifest.claimed_to_exclusive:
                raise InvalidRow("booking_outside_coverage","booked_on")
            row["value_on"]=day(row["value_on"],"value_on").isoformat() if row["value_on"] else None
            choice(row["status"],"status",("pending","booked","reversed"))
            text(row["merchant"],"merchant",2000)
            if not re.fullmatch(r"[a-z][a-z0-9_]{0,99}",row["category"],re.ASCII):
                raise InvalidRow("invalid_category","category")
            choice(row["basket"],"basket",("mandatory_regular","mandatory_irregular","everyday","unresolved"))
            choice(row["economic_flow"],"economic_flow",("expense","refund","income","internal_transfer","liability_settlement","unknown"))
            if (row["economic_flow"]=="expense" and row["amount_minor"]>0) or (row["economic_flow"] in ("income","refund") and row["amount_minor"]<0):
                raise InvalidRow("flow_sign_mismatch","amount_minor","economic_flow")
            if bool(row["related_account_ref"])!=bool(row["related_source_id"]):
                raise InvalidRow("incomplete_relation","related_account_ref","related_source_id")
            for field in ("related_account_ref","related_source_id"):
                row[field]=reference(row[field],field) if row[field] else None
    return row


def parse_chunk(body,*,role,offset,ordinal,size_bytes,manifest,as_of,deadline):
    if role not in ROLES or not 0<=offset<=size_bytes or not 0<=ordinal<=MAX_ROWS:
        raise CsvSourceError("import_invalid_checkpoint")
    lines=PhysicalLines(body,offset,size_bytes,deadline)
    reader=csv.reader(lines,delimiter=",",quotechar='"',strict=True)
    rows=[];chunk_start=offset
    try:
        if offset==0:
            try: header=next(reader)
            except StopIteration: raise CsvSourceError("import_csv_header_missing") from None
            if tuple(header)!=COLUMNS[role]: raise CsvSourceError("import_csv_header_mismatch")
        while len(rows)<CHUNK_ROWS and lines.offset-chunk_start<CHUNK_BYTES:
            start=lines.offset;lines.reset_record()
            try: cells=next(reader)
            except StopIteration: return CsvChunk(rows,lines.offset,True)
            number=ordinal+len(rows)+1
            if number>ROLE_LIMITS[role]: raise CsvSourceError("import_csv_row_limit")
            try:
                payload=validate_row(role,cells,manifest,as_of)
                rows.append(SourceRow(number,start,lines.offset,lines.digest.hexdigest(),payload,[],[]))
            except InvalidRow as error:
                rows.append(SourceRow(number,start,lines.offset,lines.digest.hexdigest(),None,[error.code],error.fields))
        return CsvChunk(rows,lines.offset,False)
    except csv.Error: raise CsvSourceError("import_csv_syntax") from None
