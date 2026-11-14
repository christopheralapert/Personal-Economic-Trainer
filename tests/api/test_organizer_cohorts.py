"""Small synthetic fixtures exercise aggregation/privacy without the 346 MiB CSV."""
import importlib.util
import json
import sys
from collections import defaultdict
from pathlib import Path

SCRIPTS=Path(__file__).resolve().parents[2]/'scripts'
sys.path.insert(0,str(SCRIPTS))
from build_organizer_data import build_cohorts, distribution, fallback_keys, quantile, save
from organizer_rules import RULES, basket, observe_recurrence, recurrence_candidates
from import_junction_demo import CATEGORY, normalize

def fixture(n=30):
    stats={};monthly=defaultdict(dict)
    for number in range(n):
        customer=f'test-{number}'
        stats[customer]={'age_band':'35-44','postal_prefix':'00','months':{f'2026-{month:02d}' for month in range(1,7)}}
        for month in stats[customer]['months']:
            monthly[customer,month]={'category:dining':(number+1)*100,'basket:everyday':(number+1)*100,'income':10000}
    return stats,monthly

def test_known_customer_then_cohort_medians_and_income_share():
    stats,monthly=fixture()
    cells,suppressed=build_cohorts(stats,monthly)
    assert suppressed==0
    assert cells['35-44/00']['metrics']['category:dining']=={'n':30,'median':16,'p25':8,'p75':23}
    assert cells['35-44/00']['income_share_bps']['everyday']=={'n':30,'median':1550,'p25':825,'p75':2275}
    assert quantile([100,200,300,400],.5)==250

def test_suppression_minimum_history_and_fallback_order():
    stats,monthly=fixture(29)
    cells,suppressed=build_cohorts(stats,monthly)
    assert cells=={} and suppressed==3
    stats,monthly=fixture(30);stats['test-0']['months']={'2026-01'}
    assert build_cohorts(stats,monthly)[0]=={}
    assert fallback_keys('35-44','00')==['35-44/00','35-44','all']

def source_row(**changes):
    return {'customer_id':'test','bank_account_id':'account','tx_date':'2026-01-01','tx_timestamp':'01JAN26:12:00:00','category':'Transportation','tx_amount_eur':'-50.00','balance_after_eur':'100.00','transaction_type':'purchase','merchant_id':'transit','mcc_code':'4111',**changes}

def test_all_source_categories_have_one_policy_and_groceries_are_everyday():
    assert set(RULES['categories'])=={'Housing','Utilities','Groceries','Restaurants','Health','Home & Tech','Transportation','Lifestyle','Entertainment','Travel','Salary','Other Income','Invest Deposit','Invest Withdraw','Salary Sweep'}
    assert basket(source_row(category='Groceries'))==('everyday','everyday_purchase')
    assert basket(source_row(category='Home & Tech'))[0]=='unresolved'
    for category,kind in [('Invest Deposit','investment_deposit'),('Invest Withdraw','investment_withdrawal'),('Salary Sweep','salary_sweep')]:
        assert normalize(source_row(category=category,transaction_type=kind),1)['economic_flow']=='internal_transfer'

def test_monthly_recurrence_is_evidence_not_merchant_or_sign_guess():
    monthly=defaultdict(dict)
    for month,amount in [(1,'-50'),(2,'-52'),(3,'-55')]:
        observe_recurrence(monthly,source_row(tx_date=f'2026-{month:02d}-01',tx_amount_eur=amount))
    recurring=recurrence_candidates(monthly)
    assert basket(source_row(),recurring)==('mandatory_regular','recurring_pattern')
    assert basket(source_row(tx_amount_eur='-100'),recurring)[0]=='everyday'
    assert basket(source_row(mcc_code='4121'),recurring)[0]=='everyday'
    assert basket(source_row(merchant_id='.'),recurring)[0]=='everyday'
    # Many purchases in just one month are not a monthly obligation.
    once=defaultdict(dict)
    for _ in range(3):observe_recurrence(once,source_row())
    assert recurrence_candidates(once)=={}

def test_output_is_byte_deterministic_and_contains_only_aggregate_cells(tmp_path):
    stats,monthly=fixture()
    first=build_cohorts(stats,monthly)[0]
    second=build_cohorts(dict(reversed(list(stats.items()))),monthly)[0]
    save(tmp_path/'one.json',first);save(tmp_path/'two.json',second)
    assert (tmp_path/'one.json').read_bytes()==(tmp_path/'two.json').read_bytes()
    assert 'test-' not in json.dumps(first)
    actual=json.loads((SCRIPTS.parent/'frontend/coach/data/cohorts.v1.json').read_text(encoding='utf-8-sig'))
    assert actual['provenance']['row_count']==3626755
    assert all(cell['n']>=30 for cell in actual['cells'].values())
    assert 'CUST' not in json.dumps(actual)
    assert (SCRIPTS.parent/'frontend/coach/data/cohorts.v1.json').stat().st_size<100*1024
