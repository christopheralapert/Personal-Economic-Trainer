"""Shared organizer-only policy; no bank-import identities or inferred private purpose."""
import json
from collections import defaultdict
from decimal import Decimal
from pathlib import Path

RULES = json.loads((Path(__file__).resolve().parents[1] / 'frontend/coach/data/organizer-rules.v1.json').read_text(encoding='utf-8-sig'))

def cents(value):
    result = Decimal(value) * 100
    if result != result.to_integral_value():
        raise ValueError('Non-cent amount')
    return int(result)

def category(row):
    return 'taxi' if row['category'] == 'Transportation' and row['mcc_code'].strip() == '4121' else RULES['categories'][row['category']]['category']

def recurrence_key(row):
    rule = RULES['categories'][row['category']]
    # Missing card metadata cannot establish a recurring merchant. Taxi rides
    # are discretionary; their repetition does not establish an obligation.
    merchant = row['merchant_id'].strip()
    if not rule['recurrence'] or merchant in ('', '.') or category(row) == 'taxi':
        return None
    return (row['customer_id'], row['category'], merchant)

def recurrence_candidates(monthly):
    """Only one debit per merchant/category/month; >=3 amounts in a 10% band.

    Return qualifying monthly amounts, rather than promoting every purchase
    made at a merchant which also has a subscription.
    """
    result = {}
    for key, months in monthly.items():
        amounts = sorted(value[0] for value in months.values() if value[1] == 1 and value[0] > 0)
        qualifying = set()
        for index, low in enumerate(amounts):
            similar = [amount for amount in amounts[index:] if amount * 100 <= low * 110]
            if len(similar) >= 3:
                qualifying.update(similar)
        if qualifying:
            result[key] = qualifying
    return result

def basket(row, recurring=None):
    rule = RULES['categories'][row['category']]
    key = recurrence_key(row)
    if key and recurring and abs(cents(row['tx_amount_eur'])) in recurring.get(key, set()):
        return 'mandatory_regular', 'recurring_pattern'
    return rule['basket'], rule['basis']

def observe_recurrence(monthly, row):
    key = recurrence_key(row)
    if key and cents(row['tx_amount_eur']) < 0 and row['transaction_type'] in ('purchase', 'housing_payment', 'utilities_payment'):
        month = row['tx_date'][:7]
        amount, count = monthly[key].get(month, (0, 0))
        monthly[key][month] = (amount + abs(cents(row['tx_amount_eur'])), count + 1)

def age_band(age):
    age = int(age)
    for low, high in ((18,24),(25,34),(35,44),(45,54),(55,64)):
        if low <= age <= high:
            return f'{low}-{high}'
    if age >= 65:
        return '65+'
    raise ValueError('Unexpected customer age')
