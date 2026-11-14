"""Local, flow-first classification shared by statement and bank ingestion."""
import hashlib
import re
import unicodedata
from typing import Literal
from pydantic import Field
from .contracts import Contract

Category = Literal['taxi','dining','groceries','housing','repairs','coffee','other','utilities','phone',
    'insurance','transport','health','pharmacy','home_tech','lifestyle','entertainment','travel']
Flow = Literal['expense','refund','income','internal_transfer','liability_settlement','unknown']
MCC = {'4121':'taxi', **dict.fromkeys(('5411','5422','5441','5451','5462','5499'),'groceries'),
    **dict.fromkeys(('5812','5813','5814'),'dining'),'4900':'utilities','5912':'pharmacy'}
BASKETS = dict.fromkeys(Category.__args__, 'everyday') | {'housing':'mandatory_regular',
    'utilities':'mandatory_regular','phone':'mandatory_regular','insurance':'mandatory_regular',
    'repairs':'mandatory_irregular','health':'mandatory_irregular','pharmacy':'mandatory_irregular'}

class Classification(Contract):
    economic_flow: Flow = 'unknown'
    category: Category | None = None
    basket: Literal['mandatory_regular','mandatory_irregular','everyday','unresolved'] = 'unresolved'
    basis: Literal['source_rule','user_rule','gemini','needs_review'] = 'needs_review'
    # Model suggestions may fill missing merchant evidence, never arbitrate a
    # conflict between source facts or an explicitly confirmed private rule.
    cloud_eligible: bool = False

    @property
    def needs_review(self):
        return self.economic_flow == 'unknown' or (self.economic_flow in ('expense','refund') and self.category is None)

def merchant_key(value):
    return hashlib.sha256(normalize_merchant(value).encode()).hexdigest()

def normalize_merchant(value):
    return ' '.join(unicodedata.normalize('NFKC',value).upper().split())

def cloud_merchant(value):
    """Fail closed: only an entire bounded business label, never an extracted memo."""
    value=normalize_merchant(value)
    if len(value)>80 or not re.fullmatch(r'[A-ZÄÖÜÕÅÉ &.\-]+',value): return None
    if re.search(r'\b(?:PAYMENT|TRANSFER|REFUND|SALARY|REFERENCE|INVOICE|IBAN|ACCOUNT|TO|FROM)\b',value): return None
    # Multi-service brands cannot be disambiguated using their name alone.
    if re.fullmatch(r'(?:BOLT|WOLT)(?: (?:OY|OÜ|LTD|AB))?',value): return None
    # Unknown company/person labels cannot be reliably de-identified by regex.
    # Only exact public-brand aliases leave this boundary; no memo extraction.
    match=re.fullmatch(r'(STARBUCKS|ESPRESSO HOUSE|IKEA|H&M|LIDL|PRISMA|NETFLIX|SPOTIFY|STEAM)(?: (?:OY|OYJ|OÜ|AS|AB|LTD|LIMITED|INC|LLC)\.?)?',value)
    return match[1] if match else None

def category_for_mcc(value):
    category=MCC.get(str(value or ''))
    return (category,BASKETS[category]) if category else ('unclassified','unresolved')

def local_classification(row, rules=None):
    amount=row.amount_minor
    explicit_flow=getattr(row,'economic_flow',None)
    flow=explicit_flow or 'unknown'
    ref=row.reference.upper()
    if explicit_flow is None and re.match(r'^(?:CARD|CARD_TRANSACTION)-',ref) and amount<0: flow='expense'
    if explicit_flow is None and re.match(r'^CARD_REFUND-',ref) and amount>0: flow='refund'
    if (flow=='expense' and amount>=0) or (flow in ('refund','income') and amount<=0):return Classification()
    if flow not in ('expense','refund'):
        return Classification(economic_flow=flow,basis='source_rule' if flow!='unknown' else 'needs_review')
    merchant=getattr(row,'merchant',None) or row.description
    mcc=str(getattr(row,'mcc',None) or '')
    source=getattr(row,'source_category',None)
    evidence=set()
    if mcc in MCC:evidence.add(MCC[mcc])
    if source in BASKETS:evidence.add(source)
    if re.fullmatch(r'BOLT\s*\*\s*RIDE(?:S)?',normalize_merchant(merchant)):evidence.add('taxi')
    if re.fullmatch(r'BOLT\s*\*\s*FOOD',normalize_merchant(merchant)):evidence.add('dining')
    if len(evidence)>1:return Classification(economic_flow=flow)
    learned=(rules or {}).get((merchant_key(merchant),flow))
    if learned and evidence and learned not in evidence:return Classification(economic_flow=flow)
    if learned:
        return Classification(economic_flow=flow,category=learned,basket=BASKETS[learned],basis='user_rule')
    if evidence:
        category=evidence.pop()
        return Classification(economic_flow=flow,category=category,basket=BASKETS[category],basis='source_rule')
    return Classification(economic_flow=flow,cloud_eligible=True)

class RowReview(Contract):
    index: int = Field(strict=True,ge=0,le=999)
    economic_flow: Flow
    category: Category | None = None
    remember_merchant: bool = False

    def classification(self, amount):
        if (self.economic_flow=='expense' and amount>=0) or (self.economic_flow in ('refund','income') and amount<=0):raise ValueError('direction_mismatch')
        if self.economic_flow not in ('expense','refund') and self.category is not None:raise ValueError('nonspending_category')
        return Classification(economic_flow=self.economic_flow,category=self.category,
            basket=BASKETS[self.category] if self.category else 'unresolved',basis='user_rule')

def load_rules(connection, owner):
    return {(r[0],r[1]):r[2] for r in connection.execute('''SELECT merchant_key,economic_flow,category
        FROM moneylens.merchant_rules WHERE tenant_id=%s AND owner_user_id=%s''',owner).fetchall()}

def save_rule(connection, owner, merchant, classification):
    if classification.economic_flow not in ('expense','refund') or classification.category is None:raise ValueError('rule_requires_spending')
    connection.execute('''INSERT INTO moneylens.merchant_rules(tenant_id,owner_user_id,merchant_key,economic_flow,category)
        VALUES(%s,%s,%s,%s,%s) ON CONFLICT(tenant_id,owner_user_id,merchant_key,economic_flow)
        DO UPDATE SET category=excluded.category,updated_at=clock_timestamp()''',
        (*owner,merchant_key(merchant),classification.economic_flow,classification.category))
