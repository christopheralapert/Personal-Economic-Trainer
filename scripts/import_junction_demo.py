"""Stream the verified public Junction CSV into bounded, reproducible demo profiles.
Raw CSV stays outside Git. No network, database, bank or model calls.
"""
import argparse,csv,hashlib,json,uuid
from collections import Counter,defaultdict
from decimal import Decimal
from pathlib import Path
try:
 from organizer_rules import basket as organizer_basket, RULES
except ModuleNotFoundError:
 from scripts.organizer_rules import basket as organizer_basket, RULES

SOURCE_SHA='49b3265d8e44e751de305a074dcffcda732bb79aa1e07b46fcca774ce76f1e63'
CUSTOMERS=('CUST02478','CUST03619','CUST03628')
COLUMNS=['customer_id','bank_account_id','tx_date','tx_timestamp','category','tx_amount_eur','balance_after_eur','transaction_type','merchant_id','mcc_code']
CATEGORY={key:value['category'] for key,value in RULES['categories'].items()}
TYPES={'purchase':'expense','housing_payment':'expense','utilities_payment':'expense','salary':'income','other_income':'income','investment_deposit':'internal_transfer','investment_withdrawal':'internal_transfer','salary_sweep':'internal_transfer'}

def minor(value):
 amount=Decimal(value)*100
 if amount!=amount.to_integral_value(): raise ValueError('Non-cent amount')
 return int(amount)

def normalize(row,number):
 # The organizer brief defines '.' and blank merchant/MCC fields as missing
 # non-card metadata, not evidence of an own-account transfer.
 merchant=row['merchant_id'].strip()
 mcc=row['mcc_code'].strip()
 category='taxi' if row['category']=='Transportation' and mcc=='4121' else CATEGORY[row['category']]
 flow=TYPES[row['transaction_type']];amount=minor(row['tx_amount_eur'])
 if (flow=='expense' and amount>0) or (flow=='income' and amount<0): raise ValueError('Unexpected amount sign')
 basket,basis=organizer_basket(row)
 account=str(uuid.uuid5(uuid.NAMESPACE_URL,'junction/s-pankki/'+row['customer_id']+'/'+row['bank_account_id']))
 # Source has no transaction ID. The verified file hash + physical row is a
 # reproducible synthetic identity, never used by the real banking importer.
 identity=str(uuid.uuid5(uuid.NAMESPACE_URL,SOURCE_SHA+'/'+str(number)))
 return dict(id=identity,account_id=account,amount_minor=amount,currency='EUR',booked_on=row['tx_date'],category=category,merchant=merchant if merchant not in ('','.') else row['category']+' / '+row['tx_date'],status='booked',economic_flow=flow,basket=basket,basket_basis=basis)

def extract(path,output):
 with path.open("rb") as prefix:has_bom=prefix.read(3)==b"\xef\xbb\xbf"
 digest=hashlib.sha256()
 with path.open('rb') as stream:
  for block in iter(lambda:stream.read(1024*1024),b''):digest.update(block)
 if digest.hexdigest()!=SOURCE_SHA:raise ValueError('Source hash mismatch')
 selected=defaultdict(list);last={};count=0;first=None;end=None
 with path.open(encoding='utf-8-sig',newline='') as stream:
  reader=csv.DictReader(stream)
  if reader.fieldnames!=COLUMNS:raise ValueError('Schema mismatch')
  for number,row in enumerate(reader,1):
   count+=1;first=min(first or row['tx_date'],row['tx_date']);end=max(end or row['tx_date'],row['tx_date'])
   if row['customer_id'] not in CUSTOMERS:continue
   tx=normalize(row,number);selected[row['customer_id']].append(tx)
   # Preserve source processing order; timestamps are not globally sorted.
   last[(row['customer_id'],tx['account_id'])]=(row['tx_date'],minor(row['balance_after_eur']))
 output.mkdir(parents=True,exist_ok=True);summaries=[]
 for index,customer in enumerate(CUSTOMERS,1):
  rows=selected[customer]
  if not rows:raise ValueError('Selected profile missing')
  account_ids=sorted({r['account_id'] for r in rows})
  profile=dict(as_of=end+'T20:59:59Z',name=customer,mode='synthetic',transactions=rows,accounts=[dict(id=a,included=True,currency='EUR',name=customer,institution_id='s-pankki-organizer') for a in account_ids],balances=[dict(account_id=a,amount_minor=last[(customer,a)][1],included_credit_minor=0,observed_at=last[(customer,a)][0]+'T20:59:59Z',pending_reflection='included') for a in account_ids],bills_minor=0,buffer_minor=0,essentials_minor=0)
  (output/f'organizer-{index}.v1.json').write_text(json.dumps(dict(notice='Organizer synthetic subset; inferred categories and baskets; reserves not supplied; history is not certified complete.',profiles=[profile]),separators=(',',':')),encoding='utf-8')
  summaries.append(dict(key=f'organizer{index}',customer=customer,rows=len(rows),accounts=len(account_ids),first=min(r['booked_on'] for r in rows),last=max(r['booked_on'] for r in rows),reference_date=end,taxi_rows=sum(r['category']=='taxi' for r in rows),category_counts=dict(Counter(r['category'] for r in rows))))
 report=dict(source='https://github.com/hackjunction/Junction-2026-S-pankki',file='tx_junction_transactions.csv',sha256=SOURCE_SHA,bytes=path.stat().st_size,source_rows=count,utf8_bom=has_bom,source_period=dict(start=first,through=end),selection='All rows for three fixed profiles with salary, housing, dining and MCC 4121 taxi records; no sampled or invented transactions.',profiles=summaries)
 (output/'organizer-source.json').write_text(json.dumps(report,indent=2)+'\n',encoding='utf-8')
 print(json.dumps(dict(source_rows=count,selected_rows=sum(s['rows'] for s in summaries),profiles=len(summaries))))

if __name__=='__main__':
 parser=argparse.ArgumentParser();parser.add_argument('source',type=Path);parser.add_argument('--output',type=Path,default=Path('complete-ui/data'));args=parser.parse_args();extract(args.source,args.output)
