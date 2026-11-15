"""Exact EUR magnitude predicates; never infer spending from the sign of a row."""
import re
from dataclasses import dataclass,field

OPERATORS=r'at least|at most|more than|greater than|less than|over|above|under|below|yli|alle|vähintään|enintään|üle|alla|vähemalt|kuni|>=|<=|>|<'
NUMBER=r'[0-9]{1,16}(?:[.,][0-9]{1,2})?'
QUOTED=r'"(?:\\.|[^"\\])*"'
CANDIDATE=re.compile(rf'(?:\b(?:{OPERATORS})|[<>]=?)\s*[+−-]?\s*(?:(?:[A-Z]{{3}}|[€$£])\s*)?[+−-]?[0-9]',re.I)
PATTERN=re.compile(rf'(?<![\w])({OPERATORS})\s*(?:(?:EUR|€)\s*({NUMBER})|({NUMBER})\s*(?:EUR|€|euron|euroa|eurot|euros?|euro))(?=$|\s|[?!.,])',re.I)
LIMIT=2**53-1

def mask(text):
    text=re.sub(QUOTED,lambda match:' '*len(match[0]),text)
    return re.sub(r'\bkuni (?=\d{4}-\d{2}-\d{2}\b)','     ',text,flags=re.I)

@dataclass
class AmountSelection:
    text:str
    present:bool=False
    valid:bool=False
    bounds:dict=field(default_factory=dict)

def amount_selection(question):
    masked=mask(question)
    result=AmountSelection(question,bool(CANDIDATE.search(masked) or re.search(r'\b(?:between|välillä)\s*[€$£]?\s*\d',masked,re.I)))
    if not result.present:return result
    matches=list(PATTERN.finditer(masked))
    if not 1<=len(matches)<=2:return result
    for match in matches:
        whole,_,fraction=(match[2] or match[3]).replace(',','.').partition('.')
        cents=int(whole)*100+int(fraction.ljust(2,'0') or '0')
        op=match[1].lower();lower=op in ('over','above','more than','greater than','yli','üle','>','at least','vähintään','vähemalt','>=')
        inclusive=op in ('at least','at most','vähintään','enintään','vähemalt','kuni','>=','<=')
        if not inclusive:cents+=1 if lower else -1
        if not 0<=cents<=LIMIT:return result
        key='amount_min_minor' if lower else 'amount_max_minor'
        if key in result.bounds:return result
        result.bounds[key]=cents
    text=question
    for match in reversed(matches):text=text[:match.start()]+text[match.end():]
    if len(matches)==2:
        if not re.fullmatch(r'\s*(?:and|ja)?\s*',masked[matches[0].end():matches[1].start()],re.I):return result
        text=question[:matches[0].start()]+question[matches[1].end():]
    remaining=mask(text)
    if CANDIDATE.search(remaining) or re.search(r'[<>]|\b(?:or|between|välillä)\b',remaining,re.I):return result
    if result.bounds.get('amount_min_minor',0)>result.bounds.get('amount_max_minor',LIMIT):return result
    pieces=re.split('('+QUOTED+')',text.strip().rstrip('?.').strip())
    text=''.join(part if index%2 else re.sub(r'\s+',' ',part) for index,part in enumerate(pieces))
    localized=re.fullmatch(r'(?:näytä|näita) (?:viime kuun|eelmise kuu) (.+)',text,re.I)
    english=re.fullmatch(r"(?:show|list|find) (?:me )?(last month's|this month's) (.+?) (?:rides|transactions)(.*)",text,re.I)
    if localized:text=f'Show transactions {localized[1]} last month'
    elif english:text=f"Show transactions {english[2]}{english[3]} "+('last month' if english[1].lower()=="last month's" else 'this month')
    result.text=text;result.valid=True;return result
