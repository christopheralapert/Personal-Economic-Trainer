"""Small hand-labelled synthetic examples for the private import preview."""
from pathlib import Path
from scripts.generate_wise_fixtures import bundle
TAXIS=(('CARD-AUTO-1','03-10-2026','-15.00','BOLT *RIDE'),
       ('CARD-AUTO-2','03-10-2026','-15.97','BOLT *RIDE'))
MIXED=TAXIS+(
    ('CARD-AUTO-3','04-10-2026','-4.00','STARBUCKS OY'),
    ('CARD-AUTO-4','04-10-2026','-2.00','Starbucks Ltd'),
    ('CARD-AUTO-5','04-10-2026','-8.00','BOLT'),
    ('TRANSFER-AUTO-6','04-10-2026','-50.00','BOLT *RIDE'),
    ('TRANSFER-AUTO-7','04-10-2026','6.00','BOLT *RIDE'),
    ('CARD-AUTO-8','04-10-2026','-3.00','John Syntheticperson'),
    ('CARD_REFUND-AUTO-9','04-10-2026','1.00','BOLT *RIDE'))

def write(directory):
    directory=Path(directory);directory.mkdir(parents=True,exist_ok=True)
    for format,content in bundle(iban='BE00000000000000',rows=TAXIS).items():
        (directory/('auto-taxis.'+format)).write_bytes(content)
    (directory/'auto-mixed.csv').write_bytes(bundle(rows=MIXED)['csv'])
    (directory/'auto-later.csv').write_bytes(bundle(rows=(('CARD-AUTO-LATER','12-11-2026','-3.00','STARBUCKS OY'),))['csv'])
    (directory/'auto-700.csv').write_bytes(bundle(rows=tuple((f'CARD-LARGE-{i}','03-10-2026','-1.00','BOLT *RIDE') for i in range(700)))['csv'])

if __name__=='__main__':
    import sys
    write(sys.argv[1] if len(sys.argv)>1 else '.cache/auto-classification-fixtures')
