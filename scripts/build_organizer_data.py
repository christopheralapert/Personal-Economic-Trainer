"""Two streaming CSV passes. Memory contains monthly aggregates and eight profiles,
never the full transaction file. No network, database, bank or model operations.
"""
import argparse
import csv
import hashlib
import json
from collections import Counter, defaultdict
from decimal import Decimal, ROUND_HALF_UP
from pathlib import Path
from organizer_rules import RULES, age_band, basket, category, cents, observe_recurrence, recurrence_candidates
from import_junction_demo import SOURCE_SHA, COLUMNS, normalize
from select_organizer_personas import select_personas

MIN_N = 30
CATEGORIES = sorted({item['category'] for item in RULES['categories'].values()} - {'salary','other_income','investment','transfer'} | {'taxi'})
BASKETS = ['mandatory_regular','mandatory_irregular','everyday','unresolved']

def quantile(values, fraction):
    values = sorted(Decimal(value) for value in values)
    if not values:
        raise ValueError('Empty quantile')
    index = Decimal(len(values)-1) * Decimal(str(fraction))
    low = int(index)
    high = min(low+1,len(values)-1)
    return values[low] + (values[high]-values[low])*(index-low)

def whole(value):
    return int(Decimal(value).quantize(Decimal(1),rounding=ROUND_HALF_UP))

def distribution(values, divisor=100, minimum=MIN_N):
    if len(values) < minimum:
        return None
    return dict(n=len(values),median=whole(quantile(values,.5)/divisor),p25=whole(quantile(values,.25)/divisor),p75=whole(quantile(values,.75)/divisor))

def fallback_keys(band, prefix):
    return [f'{band}/{prefix}',band,'all']

def build_cohorts(stats, monthly, minimum=MIN_N):
    cells = defaultdict(list)
    for customer, item in sorted(stats.items()):
        if len(item['months']) < 6:
            continue
        for key in fallback_keys(item['age_band'],item['postal_prefix']):
            cells[key].append(customer)
    result = {}; suppressed = 0
    for key, members in sorted(cells.items()):
        if len(members) < minimum:
            suppressed += 1
            continue
        metrics = {}; shares = {}
        for metric in ['category:'+key for key in CATEGORIES] + ['basket:'+key for key in BASKETS]:
            values = [quantile([monthly[customer,month].get(metric,0) for month in sorted(stats[customer]['months'])],.5) for customer in members]
            metrics[metric] = distribution(values,minimum=minimum)
        for bucket in BASKETS:
            values = []
            for customer in members:
                # A ratio is observed only in months with actual salary/other income.
                ratios = [Decimal(monthly[customer,month].get('basket:'+bucket,0))*10000/monthly[customer,month]['income'] for month in sorted(stats[customer]['months']) if monthly[customer,month].get('income',0)>0]
                if ratios:
                    values.append(quantile(ratios,.5))
            shares[bucket] = distribution(values,divisor=1,minimum=minimum)
        result[key] = dict(n=len(members),metrics=metrics,income_share_bps=shares)
    return result, suppressed

def rows(path):
    with path.open(encoding='utf-8-sig',newline='') as stream:
        reader=csv.DictReader(stream)
        if reader.fieldnames != COLUMNS:
            raise ValueError('Transaction schema mismatch')
        for number,row in enumerate(reader,1):
            if not '2024-10-01' <= row['tx_date'] <= '2026-09-30':
                raise ValueError('Unexpected source date')
            yield number,row

def save(path,value):
    path.write_text(json.dumps(value,ensure_ascii=False,separators=(',',':'),sort_keys=True)+'\n',encoding='utf-8')

def generate(root, output, docs, generation_date='2026-11-13'):
    source=root/'tx_junction_transactions.csv'
    digest=hashlib.sha256()
    with source.open('rb') as stream:
        for block in iter(lambda:stream.read(1024*1024),b''):
            digest.update(block)
    if source.stat().st_size != 362796501 or digest.hexdigest()!=SOURCE_SHA:
        raise ValueError('Organizer source identity mismatch; no data generated')
    with (root/'tx_customers_junction.csv').open(encoding='utf-8-sig',newline='') as stream:
        customers={row['customer_id']:row for row in csv.DictReader(stream)}
    with (root/'mtg_tx_customer_link_and_final_mtg_infio.csv').open(encoding='utf-8-sig',newline='') as stream:
        mortgages=list(csv.DictReader(stream))
    linked={row['customer_id'] for row in mortgages}
    stats={key:dict(age_band=age_band(row['customer_age']),postal_prefix=row['customer_postal_code'][:2],months=set(),accounts=set(),salary=False,investment=False,mortgage=key in linked,taxi_count=0,dining=0,everyday=0,rows=0) for key,row in customers.items()}
    recurrence=defaultdict(dict); count=0; source_categories=Counter()
    for _,row in rows(source):
        count+=1; item=stats[row['customer_id']]; item['rows']+=1
        item['months'].add(row['tx_date'][:7]);item['accounts'].add(row['bank_account_id'])
        item['salary'] |= row['transaction_type']=='salary'
        item['investment'] |= row['transaction_type']=='investment_deposit'
        key=category(row); amount=cents(row['tx_amount_eur']);source_categories[row['category']]+=1
        if row['transaction_type']=='purchase':
            item['taxi_count']+=key=='taxi'
            item['dining']+=-amount if key=='dining' else 0
            item['everyday']+=-amount if basket(row)[0]=='everyday' else 0
        observe_recurrence(recurrence,row)
    recurring=recurrence_candidates(recurrence)
    del recurrence
    selected,criteria=select_personas(stats)
    monthly=defaultdict(lambda:defaultdict(int)); profiles=defaultdict(list);last={}
    for number,row in rows(source):
        customer=row['customer_id']; month=row['tx_date'][:7]; amount=cents(row['tx_amount_eur']);key=category(row); bucket,basis=basket(row,recurring)
        if row['transaction_type'] in ('salary','other_income'):
            if amount<0:raise ValueError('Unexpected income sign')
            monthly[customer,month]['income']+=amount
        elif row['transaction_type'] in ('purchase','housing_payment','utilities_payment'):
            if amount>0:raise ValueError('Unexpected expense sign')
            monthly[customer,month]['category:'+key]+=-amount
            monthly[customer,month]['basket:'+bucket]+=-amount
        if customer in selected:
            tx=normalize(row,number);tx.update(basket=bucket,basket_basis=basis)
            profiles[customer].append(tx)
            last[customer,tx['account_id']]=(row['tx_date'],cents(row['balance_after_eur']))
    cells,suppressed=build_cohorts(stats,monthly)
    customer_hash=hashlib.sha256((root/'tx_customers_junction.csv').read_bytes()).hexdigest()
    provenance=dict(transaction_sha256=SOURCE_SHA,customer_sha256=customer_hash,row_count=count,customer_count=len(stats),eligible_customers=sum(len(item['months'])>=6 for item in stats.values()),period={'start':'2024-10-01','through':'2026-09-30','complete_months':24},rule_version=RULES['version'],generation_date=generation_date,minimum_n=MIN_N,population='Synthetic Helsinki-region customers; not Finland',suppressed_cells=suppressed)
    output.mkdir(parents=True,exist_ok=True);docs.mkdir(parents=True,exist_ok=True)
    save(output/'cohorts.v1.json',dict(provenance=provenance,cells=cells))
    if (output/'cohorts.v1.json').stat().st_size>100*1024:raise ValueError('Cohort bundle exceeds budget')
    manifest={};summaries=[]
    for index,customer in enumerate(selected,1):
        item=stats[customer];transactions=profiles[customer];accounts=sorted({row['account_id'] for row in transactions})
        # Browser metadata deliberately contains neither exact age/postcode nor customer ID.
        context=dict(age_band=item['age_band'],postal_prefix=item['postal_prefix'],complete_months=len(item['months']))
        profile=dict(as_of='2026-09-30T20:59:59Z',name=f'Organizer {index}',mode='synthetic',peer_context=context,transactions=transactions,accounts=[dict(id=account,included=True,currency='EUR',name=f'Account {i+1}',institution_id='s-pankki-organizer') for i,account in enumerate(accounts)],balances=[dict(account_id=account,amount_minor=last[customer,account][1],included_credit_minor=0,observed_at=last[customer,account][0]+'T20:59:59Z',pending_reflection='included') for account in accounts],bills_minor=0,buffer_minor=0,essentials_minor=0)
        save(output/f'organizer-{index}.v1.json',dict(notice='Organizer synthetic whole-customer history; inferred baskets; reserves not supplied; coverage not certified complete.',profiles=[profile]))
        tags=[tag for tag,present in [('salaried',item['salary']),('housing',any(row['category']=='housing' for row in transactions)),('frequent_taxis',customer==criteria['highest_taxi']),('dining_heavy',customer==criteria['dining_heavy']),('investment',item['investment']),('mortgage_link',item['mortgage']),('multi_account',len(accounts)>1)] if present]
        manifest[f'organizer{index}']=dict(file=f'organizer-{index}.v1.json',**context,rows=len(transactions),tags=tags)
        summaries.append(dict(key=f'organizer{index}',customer=customer,rows=len(transactions),accounts=len(accounts),first=min(row['booked_on'] for row in transactions),last=max(row['booked_on'] for row in transactions),reference_date='2026-09-30',taxi_rows=sum(row['category']=='taxi' for row in transactions),category_counts=dict(Counter(row['category'] for row in transactions))))
    save(output/'organizer-manifest.v1.json',manifest)
    save(output/'organizer-source.json',dict(source='https://github.com/hackjunction/Junction-2026-S-pankki',file=source.name,sha256=SOURCE_SHA,bytes=source.stat().st_size,source_rows=count,utf8_bom=True,source_period={'start':'2024-10-01','through':'2026-09-30'},selection='Eight deterministic whole-customer profiles; first three stable; no sampled or invented rows.',profiles=summaries,rule_version=RULES['version']))
    doc=['# Organizer cohorts','',f'Generated deterministically with `python scripts/build_organizer_data.py` (generation date input {generation_date}).', '',json.dumps(provenance,indent=2),'','## Method','', 'Two streaming passes, decimal cents, 24 complete calendar months (October 2024–September 2026). A contributing customer has records in at least six distinct complete months. Within that customer\'s observed months, absent categories are zero; a month with no records is not assumed complete or zero. First take each customer\'s monthly median, then linear-interpolated cohort median/p25/p75, rounded half up to whole EUR. Income shares are monthly basket/income ratios (salary + other income only), customer median then cohort quantiles, stored as integer basis points; zero/missing-income months excluded. Income-share n can differ. No investment movements or salary sweeps count as spending/income. Baskets use the same rules and recurrence evidence as the persona loader.','', 'Cells use age-band/postal-prefix → age-band → all eligible customers. Each metric/cell requires at least 30 distinct contributors. Suppressed cells/metrics have no figures. No IDs, exact ages, five-digit postcodes or customer rows are published in cohorts. This is a synthetic Helsinki-region population, not a representative Finnish benchmark. Selected personas are members of their cohort (not leave-one-out); no significance or percentile claims.','', 'Postal names are approximate area labels, not municipality boundaries. In particular prefix 02 also includes Kirkkonummi/Siuntio; use neutral postal-prefix labels until a verified mapping of the actual supplied postcodes is available. [Posti postal areas](https://www.posti.fi/en/postal-code-areas), [Statistics Finland Paavo](https://stat.fi/en/services/statistical-data-services/statistical-databases/paavo). Do not blend with Statistics Finland survey context.','', '| Cell | Customers |','|---|---:|']
    doc += [f'| {key} | {value["n"]} |' for key,value in cells.items()]
    (docs/'organizer-cohorts.md').write_text('\n'.join(doc)+'\n',encoding='utf-8')
    persona_doc=['# Organizer personas','','`python scripts/select_organizer_personas.py` runs the same verified two-pass generator. Stable first three: CUST02478, CUST03619, CUST03628. The other five are selected without sampling: greatest MCC-4121 transaction count, greatest dining share of observed everyday expenditure, then greedy coverage of age/area/salary-investment/mortgage/multi-account criteria; ties sort by public synthetic customer ID. Only eligible ≥6-month customers participate. All source rows are retained, including investments, but those movements never enter spending. UUID identities remain source SHA + physical CSV row.','','Selection facts: '+json.dumps(criteria,sort_keys=True),'','Labels describe recorded data, never invented jobs, names, renter status or backstories. Mortgage-link is a flag only; no loan numbers enter the ledger, balances, planning or eligibility. Prefix labels are deliberately neutral (00/01/02) pending verified postcode mapping. The eight raw ages/postcodes remain ignored in the cache.','','| Key | Age band | Postal prefix | Months | Rows | Derived tags |','|---|---|---|---:|---:|---|']
    persona_doc += [f'| {key} | {item["age_band"]} | {item["postal_prefix"]} | {item["complete_months"]} | {item["rows"]} | {", ".join(item["tags"])} |' for key,item in manifest.items()]
    (docs/'organizer-personas.md').write_text('\n'.join(persona_doc)+'\n',encoding='utf-8')
    print(json.dumps(dict(rows=count,customers=len(stats),cells=len(cells),suppressed=suppressed,cohort_bytes=(output/'cohorts.v1.json').stat().st_size,profile_rows=sum(len(value) for value in profiles.values()),multi_account=criteria['multi_account_exists'])))

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--source',type=Path,default=Path('.cache/organizer'));parser.add_argument('--output',type=Path,default=Path('frontend/coach/data'));parser.add_argument('--docs',type=Path,default=Path('docs'));parser.add_argument('--generation-date',default='2026-11-13');args=parser.parse_args();generate(args.source,args.output,args.docs,args.generation_date)

if __name__=='__main__':main()
