"""Bounded, local Wise EUR adapters. Never log source bytes or parser exceptions.

Variants are deliberately narrow: unknown layouts fail closed rather than dropping rows.
Account identifiers describe the uploaded file, not verified bank ownership.
"""
import csv
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from decimal import Decimal
from io import BytesIO, StringIO
import re
import unicodedata
from xml.etree import ElementTree as ET
from zipfile import ZipFile, BadZipFile

from .statement_pdf import extract_statement_text, StatementPdfError
from .statement_wise import WiseRow, WiseStatementError, preview_wise_csv

MAX_FILE = 2 * 1024 * 1024
MAX_ROWS = 1000
MONTHS = {m: i+1 for i, m in enumerate(('January','February','March','April','May','June','July','August','September','October','November','December'))}
LONG_DATE = r'\d{1,2} (?:'+'|'.join(MONTHS)+r') \d{4}'


@dataclass(frozen=True, repr=False)
class Statement:
    rows: tuple[WiseRow, ...]
    variant: str
    account_key: str | None = field(default=None, repr=False)
    currency: str | None = 'EUR'
    start: date | None = None
    last: date | None = None


def fail(code='unsupported_layout'):
    raise WiseStatementError(code)


def text(content):
    try:
        return content.decode('utf-8-sig')
    except UnicodeDecodeError:
        fail('invalid_encoding')


def clean(value, limit=200):
    value = unicodedata.normalize('NFKC', value).strip()
    if len(value) > limit or any(ord(c) < 32 or 127 <= ord(c) <= 159 for c in value):
        fail('invalid_field')
    return value


def minor(value):
    if not re.fullmatch(r'-?(?:\d{1,3}(?:,\d{3})+|\d+)\.\d{2}', value):
        fail('invalid_amount')
    result = int(Decimal(value.replace(',', '')) * 100)
    if abs(result) > 2**53-1:
        fail('amount_out_of_range')
    return result


def day(value):
    try:
        return date.fromisoformat(value)
    except ValueError:
        fail('invalid_date')


def long_day(value):
    d, m, y = value.split()
    try:
        return date(int(y), MONTHS[m], int(d))
    except (ValueError, KeyError):
        fail('invalid_date')


def row(ref, booked, amount, description):
    return WiseRow(clean(ref), booked, amount, 'EUR', clean(description))


def parse_csv(content):
    parsed = preview_wise_csv(content)
    records = list(csv.DictReader(StringIO(text(content))))
    keys = {re.sub(r'\s+', '', r.get('IBAN', '')).upper() for r in records} - {''}
    if len(keys) > 1:
        fail('multiple_accounts')
    return Statement(parsed.rows, 'wise.csv.transferwise-id.v1', next(iter(keys), None))


def xml(content):
    # No DTD/entity expansion, including UTF-16 encoded declarations.
    if b'<!' in content.replace(b'\x00', b''):
        fail('unsafe_xml')
    try:
        return ET.fromstring(content)
    except ET.ParseError:
        fail('invalid_xml')


def parse_xlsx(content):
    ns = {'s': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
    try:
        with ZipFile(BytesIO(content)) as book:
            names = book.namelist()
            if len(names) != len(set(names)) or len(names) > 100 or sum(x.file_size for x in book.infolist()) > 8*1024*1024:
                fail('unsafe_workbook')
            if any('vbaProject' in n or n.startswith('xl/externalLinks/') for n in names):
                fail('unsafe_workbook')
            workbook = xml(book.read('xl/workbook.xml'))
            if len(workbook.findall('s:sheets/s:sheet', ns)) != 1:
                fail('multiple_sheets')
            props = workbook.find('s:workbookPr', ns)
            if props is not None and props.get('date1904') in ('1','true'):
                fail('unsupported_date_epoch')
            shared = []
            if 'xl/sharedStrings.xml' in names:
                shared = [''.join(e.itertext()) for e in xml(book.read('xl/sharedStrings.xml')).findall('s:si', ns)]
            sheets = [n for n in names if re.fullmatch(r'xl/worksheets/sheet\d+\.xml', n)]
            if len(sheets) != 1:
                fail('multiple_sheets')
            values = []
            for record in xml(book.read(sheets[0])).findall('s:sheetData/s:row', ns):
                if len(values) > MAX_ROWS:
                    fail('too_many_rows')
                cells = {}
                for cell in record.findall('s:c', ns):
                    address = re.fullmatch(r'([A-Z]{1,2})\d+', cell.get('r',''))
                    if not address or cell.find('s:f', ns) is not None:
                        fail('unsupported_workbook_cell')
                    index = 0
                    for letter in address[1]:
                        index = index*26+ord(letter)-64
                    if index > 100 or index in cells:
                        fail('unsupported_workbook_cell')
                    value = cell.findtext('s:v', '', ns)
                    if cell.get('t') == 's':
                        value = shared[int(value)]
                    elif cell.get('t') == 'inlineStr':
                        value = ''.join(cell.find('s:is',ns).itertext())
                    elif cell.get('t') not in (None, 'n', 'str'):
                        fail('unsupported_workbook_cell')
                    cells[index] = value
                if cells:
                    values.append([cells.get(i,'') for i in range(1,max(cells)+1)])
            if not values:
                fail()
            header = values[0]
            if 'Date' not in header:
                fail()
            for record in values[1:]:
                if len(record) != len(header):
                    fail('invalid_row')
                ix = header.index('Date')
                if re.fullmatch(r'\d+(?:\.0+)?', record[ix]):
                    record[ix] = (date(1899,12,30)+timedelta(days=int(float(record[ix])))).strftime('%d-%m-%Y')
                if 'Amount' in header:
                    ai = header.index('Amount')
                    # Numeric Excel cells may omit the trailing zeroes.
                    if not re.fullmatch(r'-?\d+(?:\.\d{1,2})?', record[ai]):
                        fail('invalid_amount')
            stream = StringIO(); writer = csv.writer(stream); writer.writerows(values)
            parsed = parse_csv(stream.getvalue().encode())
            return Statement(parsed.rows, 'wise.xlsx.csv-columns.v1', parsed.account_key)
    except (BadZipFile, KeyError, ValueError, IndexError, AttributeError, OverflowError):
        fail('invalid_workbook')


def parse_pdf(content):
    try:
        pages = extract_statement_text(content)
    except StatementPdfError as exc:
        fail(str(exc))
    source = '\n'.join(pages)
    period = re.search('('+LONG_DATE+r') \[[^\]\n]+\] - ('+LONG_DATE+r') \[[^\]\n]+\]', source)
    iban = re.search(r'(?m)^IBAN\s*\n([A-Z]{2}[0-9A-Z ]+)\s*$', source)
    if 'EUR statement' not in source or not period or not iban or not re.search(r'Description\s+Incoming\s+Outgoing\s+Amount', source):
        fail('unsupported_pdf_layout')
    start, last = long_day(period[1]), long_day(period[2])
    rows = []; pending = []; amount = None; description = None; active = False
    pair = re.compile(r'(-?(?:\d{1,3}(?:,\d{3})+|\d+)\.\d{2})\s+(-?(?:\d{1,3}(?:,\d{3})+|\d+)\.\d{2})$')
    for line in source.splitlines():
        line = line.strip()
        if re.match(r'Description\s+Incoming\s+Outgoing\s+Amount', line):
            active = True; continue
        if not active or not line or re.match(r'^ref:',line):
            continue
        detail = re.fullmatch('('+LONG_DATE+r') \| (?:.* \| )?Transaction: ([A-Za-z0-9_-]+)', line)
        if detail:
            if amount is None or not description:
                fail('incomplete_pdf_transaction')
            rows.append(row(detail[2], long_day(detail[1]), amount, description))
            pending = []; amount = None; description = None
            continue
        if 'Transaction:' in line:
            fail('unsupported_pdf_layout')
        # Exchange-rate footnotes and page furniture are not transaction descriptions.
        if re.match(r'^\d[\d.,]* (?:money |EUR )',line) or line.startswith('Wise is the trading'):
            continue
        match = pair.search(line)
        if match:
            if amount is not None:
                fail('incomplete_pdf_transaction')
            amount = minor(match[1])
            prefix = line[:match.start()].strip()
            if prefix: pending.append(prefix)
            description = ' '.join(pending)
            pending = []
        else:
            pending.append(line)
    if amount is not None or len(rows) != source.count('Transaction:'):
        fail('incomplete_pdf_transaction')
    return Statement(tuple(rows), 'wise.pdf.en.incoming-outgoing-amount.v1', re.sub(r'\s+','',iban[1]), 'EUR', start, last)


def parse_camt(content):
    root = xml(content)
    namespace = 'urn:iso:std:iso:20022:tech:xsd:camt.053.001.10'
    if root.tag != '{'+namespace+'}Document':
        fail('unsupported_camt_version')
    # Work only inside the verified namespace; no unrelated/extension elements become rows.
    ns = {'c': namespace}
    statements = root.findall('c:BkToCstmrStmt/c:Stmt',ns)
    if len(statements) != 1:
        fail('multiple_accounts')
    stmt = statements[0]
    get = lambda node,path: node.findtext('/'.join('c:'+x for x in path.split('/')), '', ns).strip()
    key = get(stmt,'Acct/Id/IBAN') or get(stmt,'Acct/Id/Othr/Id')
    if get(stmt,'Acct/Ccy') != 'EUR':
        fail('unsupported_currency')
    rows = []
    for entry in stmt.findall('c:Ntry',ns):
        if get(entry,'Sts/Cd') != 'BOOK' or entry.find('c:Amt',ns) is None or entry.find('c:Amt',ns).get('Ccy') != 'EUR':
            fail('unsupported_entry')
        details = entry.findall('c:NtryDtls/c:TxDtls',ns)
        if len(details) != 1:
            fail('unsupported_aggregate_entry')
        sign = get(entry,'CdtDbtInd')
        if sign not in ('CRDT','DBIT'):
            fail('invalid_amount')
        value = minor(get(entry,'Amt'))
        if value < 0:
            fail('invalid_amount')
        ref = get(details[0],'Refs/TxId') or get(entry,'NtryRef')
        desc = ' '.join((part.text or '').strip() for part in details[0].findall('c:RmtInf/c:Ustrd',ns)) or get(entry,'AddtlNtryInf')
        rows.append(row(ref, day(get(entry,'BookgDt/Dt')), value if sign=='CRDT' else -value, desc))
    start = get(stmt,'FrToDt/FrDtTm'); last = get(stmt,'FrToDt/ToDtTm')
    return Statement(tuple(rows), 'wise.camt.053.001.10.single-booked-entry', key or None,
        'EUR', day(start[:10]) if start else None, day(last[:10]) if last else None)


def parse_mt940(content):
    lines = text(content).splitlines(); fields = []
    for line in lines:
        match = re.fullmatch(r':(\d{2}[A-Z]?):(.*)',line)
        if match: fields.append([match[1],match[2]])
        elif line and fields and fields[-1][0]=='86': fields[-1][1]+=' '+line
        elif line: fail('unsupported_mt940_layout')
    tags = [x[0] for x in fields]
    if any(tags.count(tag)!=1 for tag in ('20','25','28C','60F','62F')) or tags[-1]!='62F':
        fail('unsupported_mt940_layout')
    if any(t not in ('20','25','28C','60F','61','86','62F') for t in tags): fail('unsupported_mt940_layout')
    def balance(tag):
        raw = next(v for t,v in fields if t==tag)
        m = re.fullmatch(r'[CD](\d{6})EUR(\d+,\d{2})',raw)
        if not m: fail('unsupported_currency_or_balance')
        return datetime.strptime(m[1],'%y%m%d').date()
    start, last = balance('60F'), balance('62F'); rows = []
    for index,(tag,value) in enumerate(fields):
        if tag=='86' and (index==0 or fields[index-1][0]!='61'): fail('unsupported_mt940_layout')
        if tag!='61': continue
        m = re.fullmatch(r'(\d{6})(\d{4})?([CD])(\d+,\d{2})N[A-Z]{3}([^/\n]{1,16})(?://([^\n]{1,34}))?',value)
        if not m or index+1>=len(fields) or fields[index+1][0]!='86': fail('unsupported_mt940_layout')
        booked = datetime.strptime(m[1],'%y%m%d').date()
        if m[2]:
            candidates = [date(y,int(m[2][:2]),int(m[2][2:])) for y in (booked.year-1,booked.year,booked.year+1)]
            found = [d for d in candidates if start<=d<=last]
            if len(found)!=1: fail('ambiguous_booking_date')
            booked = found[0]
        ref = m[6] or (m[5] if m[5]!='NONREF' else '')
        value_minor = minor(m[4].replace(',','.'))
        rows.append(row(ref,booked,value_minor if m[3]=='C' else -value_minor,fields[index+1][1]))
    return Statement(tuple(rows),'wise.mt940.60F-61-86-62F',next(v for t,v in fields if t=='25'),'EUR',start,last)


def parse_qif(content, date_order):
    lines = text(content).splitlines()
    if not lines or lines[0]!='!Type:Bank': fail('unsupported_qif_layout')
    rows = []; record = {}
    for line in lines[1:]:
        if line=='^':
            if not {'D','T','P'}<=record.keys(): fail('incomplete_qif_transaction')
            raw = record['D']
            if re.fullmatch(r'\d{4}-\d{2}-\d{2}',raw): booked=day(raw)
            else:
                if date_order not in ('day_first','month_first'): fail('qif_date_order_required')
                booked=datetime.strptime(raw,'%d/%m/%Y' if date_order=='day_first' else '%m/%d/%Y').date()
            rows.append(row('',booked,minor(record['T']),record['P']+(' '+record['M'] if record.get('M') else '')))
            record = {}
        elif not line or line[0] not in 'DTPMNC' or line[0] in record:
            fail('unsupported_qif_layout')
        else: record[line[0]]=line[1:]
    if record: fail('incomplete_qif_transaction')
    return Statement(tuple(rows),'wise.qif.bank.D-T-P-M',currency=None)


def parse_statement(content, format, date_order=None):
    if not content or len(content)>MAX_FILE: fail('file_too_large')
    try:
        parsers={'csv':parse_csv,'pdf':parse_pdf,'xlsx':parse_xlsx,'xml':parse_camt,'mt940':parse_mt940}
        parsed = parse_qif(content,date_order) if format=='qif' else parsers[format](content)
        if not 1<=len(parsed.rows)<=MAX_ROWS: fail('invalid_row_count')
        start=parsed.start or min(r.booked_on for r in parsed.rows)
        last=parsed.last or max(r.booked_on for r in parsed.rows)
        if start>last or any(not start<=r.booked_on<=last for r in parsed.rows): fail('invalid_statement_period')
        key=clean(parsed.account_key,100) if parsed.account_key else None
        if key:
            compact=re.sub(r'\s+','',key).upper()
            if re.fullmatch(r'[A-Z]{2}\d{2}[A-Z0-9]{11,30}',compact):key=compact
        return Statement(parsed.rows,parsed.variant,key,parsed.currency,start,last)
    except WiseStatementError:
        raise
    except (ValueError, KeyError, OverflowError, TypeError):
        fail('invalid_statement')
