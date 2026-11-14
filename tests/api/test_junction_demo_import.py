from pathlib import Path
import importlib.util
import pytest
spec=importlib.util.spec_from_file_location('junction_importer',Path(__file__).resolve().parents[2]/'scripts/import_junction_demo.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)

def row(**changes):
 return {'customer_id':'CUST-test','bank_account_id':'account-test','tx_date':'2026-08-01','tx_timestamp':'01AUG26:12:00:00','category':'Transportation','tx_amount_eur':'-12.34','balance_after_eur':'100.00','transaction_type':'purchase','merchant_id':'','mcc_code':'4121',**changes}

def test_synthetic_mapping_uses_mcc_not_all_transport_and_has_stable_source_ids():
 taxi=module.normalize(row(),1)
 assert taxi['category']=='taxi' and taxi['amount_minor']==-1234
 assert module.normalize(row(mcc_code='4111'),2)['category']=='transport'
 assert module.normalize(row(),1)['id']==taxi['id']
 assert module.normalize(row(),2)['id']!=taxi['id']
 assert module.normalize(row(category='Home & Tech'),3)['basket']=='unresolved'

def test_transfers_never_become_expenses_and_invalid_signs_or_precision_stop_import():
 transfer=module.normalize(row(category='Invest Deposit',transaction_type='investment_deposit'),1)
 assert transfer['economic_flow']=='internal_transfer'
 with pytest.raises(ValueError):module.normalize(row(tx_amount_eur='12.34'),1)
 with pytest.raises(ValueError):module.normalize(row(tx_amount_eur='-12.345'),1)


@pytest.mark.parametrize('missing',['.','','  .  ','   '])
def test_missing_card_metadata_does_not_invent_a_merchant_or_change_payment_purpose(missing):
 housing=module.normalize(row(category='Housing',transaction_type='housing_payment',merchant_id=missing,mcc_code=missing),1)
 assert housing['merchant']=='Housing / 2026-08-01'
 assert (housing['economic_flow'],housing['basket'],housing['amount_minor'])==('expense','mandatory_regular',-1234)
 transport=module.normalize(row(merchant_id=missing,mcc_code=missing),1)
 assert transport['category']=='transport' and transport['economic_flow']=='expense'
 assert transport['id']==housing['id']  # Source identity does not depend on display metadata.
