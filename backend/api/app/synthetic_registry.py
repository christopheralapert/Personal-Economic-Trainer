"""Closed fictional demo directory; templates are authored synthetic fixtures only."""
from typing import Literal

SyntheticBankId = Literal["s-bank-demo", "north-demo", "jarve-demo", "harbour-demo", "juniper-demo", "koivu-demo", "saaristo-demo", "revontuli-demo"]
SYNTHETIC_INSTITUTIONS = {
    "s-bank-demo": {"name": "S-Bank-shaped simulator", "country": "FI", "template": "s-bank-demo"},
    "north-demo": {"name": "North demo bank (fictional)", "country": "EE", "template": "north-demo"},
    "jarve-demo": {"name": "Järve Demo Bank (fictional)", "country": "EE", "template": "north-demo"},
    "harbour-demo": {"name": "Harbour Demo Bank (fictional)", "country": "EE", "template": "north-demo"},
    "juniper-demo": {"name": "Juniper Demo Bank (fictional)", "country": "EE", "template": "north-demo"},
    "koivu-demo": {"name": "Koivu Demo Bank (fictional)", "country": "FI", "template": "s-bank-demo"},
    "saaristo-demo": {"name": "Saaristo Demo Bank (fictional)", "country": "FI", "template": "s-bank-demo"},
    "revontuli-demo": {"name": "Revontuli Demo Bank (fictional)", "country": "FI", "template": "s-bank-demo"},
}
