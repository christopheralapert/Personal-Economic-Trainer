from app.category_crosswalk import load_crosswalk
from app.identity import authorized_transaction
from app.ledger import Ledger,LedgerFilterV1
from identity_support import authenticated_app
from test_bank_publication import connect,synchronize
from test_bank_routes import finish,start,NOW


def test_real_published_ledger_mapping_preserves_all_money_without_writes(database,owners):
    crosswalk=load_crosswalk()
    with authenticated_app(database,owners) as (client,app,config):
        auth,first,user=connect(client,app,"s-bank-demo","crosswalk-first")
        synchronize(database,client,app,config,auth,first,user)
        second=start(client,auth,"north-demo","crosswalk-second");finish(client,auth,second)
        synchronize(database,client,app,config,auth,second,user,key="crosswalk-second-refresh")
        with app.state.pools.finance.connection() as connection:
            with authorized_transaction(connection,user,repeatable_read=True):
                filters=LedgerFilterV1(start="2026-10-01",end_exclusive="2026-11-01")
                totals=Ledger(connection,user,filters,now=NOW).totals()
                result=crosswalk.apply(totals,taxonomy="moneylens.synthetic.categories.v1",target_codes=["01","0533","07322","111"])
                assert result.total_observed.net_minor==86450 and result.status=="partial"
                assert result.ambiguous.gross_minor>0 and result.excluded.gross_minor>0
                assert result.unmapped.net_minor==0 and result.outside_selection.net_minor==0
                assert result.scope.data_version==totals.scope.data_version
                assert sum(getattr(result,name).net_minor for name in ("mapped","ambiguous","excluded","unmapped","outside_selection"))==86450
                assert result.nonconsumption_count==2 and not result.population_comparison_ready
                assert result.evidence_filters==totals.evidence_filters
                filtered=Ledger(connection,user,LedgerFilterV1(start="2026-10-01",end_exclusive="2026-11-01",category="taxi",merchant="Taxi"),now=NOW).totals()
                selected=crosswalk.apply(filtered,taxonomy="moneylens.synthetic.categories.v1",target_codes=["07322"])
                assert selected.evidence_filters.category=="taxi" and selected.evidence_filters.merchant=="Taxi"
                assert selected.evidence_transaction_ids==filtered.evidence_transaction_ids and selected.status=="resolved"
        taxi=client.get("/v1/analysis/spending",params={"start":"2026-10-01","end_exclusive":"2026-11-01","category":"taxi"}).json()
        assert next(item for item in result.assignments if item.target.code=="07322").assigned_observed.net_minor==taxi["net_minor"]
        assert taxi["scope"]["data_version"]==result.scope.data_version
        client.post(f"/v1/bank-connections/{first['connection']['id']}/disconnect",headers=auth,json={})
        assert client.get("/v1/analysis/spending",params={"start":"2026-10-01","end_exclusive":"2026-11-01"}).status_code==409
