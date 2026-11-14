"""Deterministic whole-customer selection, reusable by the streaming generator."""
STABLE = ('CUST02478', 'CUST03619', 'CUST03628')

def features(item):
    result = {'area:' + item['postal_prefix']}
    if item['age_band'] in ('18-24', '35-44'):
        result.add('age:' + item['age_band'])
    if item['age_band'] in ('55-64', '65+'):
        result.add('age:55+')
    if item['salary'] and item['investment']:
        result.add('salary_investment')
    if item['mortgage']:
        result.add('mortgage_link')
    if len(item['accounts']) > 1:
        result.add('multi_account')
    return result

def select_personas(stats):
    eligible = {key: value for key, value in stats.items() if len(value['months']) >= 6}
    selected = list(STABLE)
    highest_taxi = min(eligible, key=lambda key: (-eligible[key]['taxi_count'], key))
    # Heavy dining means the largest share of observed everyday expenditure.
    from fractions import Fraction
    dining = min(eligible, key=lambda key: (-Fraction(eligible[key]['dining'], max(1, eligible[key]['everyday'])), key))
    for key in (highest_taxi, dining):
        if key not in selected:
            selected.append(key)
    required = {'area:00', 'area:01', 'area:02', 'age:18-24', 'age:35-44', 'age:55+', 'salary_investment', 'mortgage_link'}
    multi = any(len(item['accounts']) > 1 for item in eligible.values())
    if multi:
        required.add('multi_account')
    while len(selected) < 8:
        covered = set().union(*(features(eligible[key]) for key in selected))
        key = min((key for key in eligible if key not in selected), key=lambda key: (-len((required-covered) & features(eligible[key])), key))
        selected.append(key)
    missing = required - set().union(*(features(eligible[key]) for key in selected))
    if missing:
        raise ValueError('Selection cannot cover required features: ' + ', '.join(sorted(missing)))
    return selected, {'highest_taxi': highest_taxi, 'dining_heavy': dining, 'multi_account_exists': multi}

if __name__ == '__main__':
    # The generator derives selection statistics by streaming the verified CSV.
    from build_organizer_data import main
    main()
