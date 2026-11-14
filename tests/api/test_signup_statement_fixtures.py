from decimal import Decimal
import csv
from io import StringIO
from scripts.generate_wise_fixtures import write_signup_bundle


def test_signup_files_are_synthetic_exact_cents_and_deliberately_overlap(tmp_path):
    write_signup_bundle(tmp_path)
    def rows(name):
        return list(csv.DictReader(StringIO((tmp_path/name).read_text(encoding='utf8'))))
    first=rows('synthetic-taxis-a.csv')
    assert len(first)==2
    assert sum(Decimal(row['Amount']) for row in first)==Decimal('-30.97')
    assert first[0]['TransferWise ID']==first[1]['TransferWise ID']
    overlap=rows('synthetic-overlap-a.csv')
    assert overlap[:2]==first and len(overlap)==3
    assert b'<Amt Ccy="EUR">7.00</Amt>' in (tmp_path/'synthetic-taxis-b.xml').read_bytes()
