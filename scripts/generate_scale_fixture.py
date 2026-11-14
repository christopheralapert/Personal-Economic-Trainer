"""Stream authored multi-owner native CSV workloads; never connect to services."""
import argparse
from calendar import monthrange
from datetime import date
import hashlib
import json
from pathlib import Path
import re
import time
from uuid import UUID,uuid5

from generate_import_fixture import write_csv
from app.import_contracts import ImportManifestV1
from app.import_csv import COLUMNS

VERSION="moneylens.scale.v1"
SEED=311045
PROFILES={"1m":1_000_000,"10m":10_000_000}
NAMESPACE=UUID("050a2e9c-0b28-447a-9f69-ad189d10467b")
START="2024-11-01"
END="2026-11-01"
OBSERVED="2026-11-04T10:00:00Z"
NEXT_OBSERVED="2026-11-05T10:00:00Z"
ACCOUNTS=("daily","reserve","card")
CATEGORIES=(("coffee","everyday"),("dining","everyday"),("taxi","unresolved"),
    ("groceries","mandatory_regular"),("housing","mandatory_regular"),("repairs","mandatory_irregular"))


def number(seed,owner,index,salt=0):
    # A versioned counter-derived value, independent of Python random/hash and
    # generation order. It is not an identifier, credential or security RNG.
    raw=f"{VERSION}:{seed}:{owner}:{index}:{salt}".encode("ascii")
    return int.from_bytes(hashlib.sha256(raw).digest()[:8],"big")


def owner_counts(rows,users=1000,heavy_rows=100000,seed=SEED):
    """Allocate whole 20-row blocks with exact totals and bounded skew."""
    if any(type(value) is not int for value in (rows,users,heavy_rows,seed)) or not 2<=users<=1000 or (
        not 20<=heavy_rows<=100000 or heavy_rows%20 or rows%20 or
        not heavy_rows+20*(users-1)<=rows<=10_000_000 or not 0<=seed<=2**32-1):
        raise ValueError("Use 2–1000 owners, whole 20-row blocks and a feasible 20–100000-row heavy owner")
    remainder=(rows-heavy_rows)//20-(users-1)
    weights=[(1+number(seed,owner,0)%20)**2 for owner in range(1,users)]
    total=sum(weights)
    blocks=[remainder*weight//total for weight in weights]
    residual=remainder-sum(blocks)
    order=sorted(range(users-1),key=lambda index:(-(remainder*weights[index]%total),index))
    for index in order[:residual]: blocks[index]+=1
    return [heavy_rows,*[20*(count+1) for count in blocks]]


def customer(seed,owner): return f"scale-{seed}-u{owner:05d}"


def transaction(seed,owner,index,*,revision=False):
    block,slot=divmod(index,20)
    value=number(seed,owner,index)
    month=2024*12+10+block%24
    year,zero_month=divmod(month,12)
    day=date(year,zero_month+1,1+value%monthrange(year,zero_month+1)[1]).isoformat()
    category,basket=CATEGORIES[value%len(CATEGORIES)]
    account=ACCOUNTS[0 if value%10<7 else 1 if value%10<9 else 2]
    amount=-(100+value%20000)
    status,flow,related_account,related_id="booked","expense","",""
    merchant=f"Synthetic {category} {value%31:02d}"
    if slot in (0,1):
        account=ACCOUNTS[slot]
        paired=number(seed,owner,block*20)
        amount=(10000+paired%40001)*(-1 if slot==0 else 1)
        category,basket,flow,merchant="transfer","unresolved","internal_transfer","Synthetic owned transfer"
        day=date(year,zero_month+1,1+paired%monthrange(year,zero_month+1)[1]).isoformat()
        related_account,related_id=ACCOUNTS[1-slot],f"tx-{block*20+1-slot:09d}"
    elif slot==2:
        account,amount,category,basket,flow,merchant="daily",250000,"salary","unresolved","income","Synthetic salary"
    elif slot==3:
        account,amount,category,basket,flow,merchant="card",100+value%2500,"dining","everyday","refund","Synthetic refund"
    elif slot==4:
        account,amount,status,category,basket="daily",-1250,"pending","taxi","unresolved"
        # A pending snapshot uses a recent date, not a two-year-old authorization.
        day="2026-10-31"
    elif slot==5: status="reversed"
    elif slot==6: flow,basket="unknown","unresolved"
    changed=revision and index==4
    if changed: amount,status=-1200,"booked"
    return (customer(seed,owner),account,f"tx-{index:09d}",2 if changed else 1,amount,"EUR",day,"",
        NEXT_OBSERVED if changed else OBSERVED,status,merchant,category,basket,flow,related_account,related_id)


def json_file(path,value):
    raw=(json.dumps(value,sort_keys=True,indent=2,ensure_ascii=True)+"\n").encode("utf-8")
    path.write_bytes(raw)
    return hashlib.sha256(raw).hexdigest()


def write_owner(output,seed,owner,count,*,revision=False,malformed=None):
    output.mkdir(parents=True,exist_ok=False)
    controls={account:[0,0] for account in ACCOUNTS}
    statistics={"expense":0,"refund":0,"income":0,"internal_transfer":0,"unknown":0,"pending":0,"reversed":0}
    def rows():
        for index in range(count):
            row=list(transaction(seed,owner,index,revision=revision))
            controls[row[1]][0]+=1;controls[row[1]][1]+=row[4]
            statistics[row[13]]+=1
            if row[9] in ("pending","reversed"): statistics[row[9]]+=1
            # Negative packages preserve original controls but carry a valid
            # byte digest. They test row rejection, not a broken upload hash.
            if malformed and index==7: row[4]="12.50"
            yield row
    files=[write_csv(output/"transactions.csv","transactions",rows())]
    files.append(write_csv(output/"accounts.csv","accounts",(
        (customer(seed,owner),account,f"Authored scale {account}","EUR","savings" if account=="reserve" else "current",
            START,END,*controls[account]) for account in ACCOUNTS)))
    files.append(write_csv(output/"balances.csv","balances",(
        (customer(seed,owner),account,f"balance-{'v2' if revision else 'v1'}-{account}",
            250000+(50 if revision and account=="daily" else 0),"EUR","available","included",0,
            NEXT_OBSERVED if revision else OBSERVED) for account in ACCOUNTS)))
    manifest={"mapping_version":"moneylens.synthetic-csv.v1",
        "source_version":f"scale-v1-{seed}-u{owner:05d}-{count}-{'invalid-money' if malformed else 'v2' if revision else 'v1'}",
        "source_customer_ref":customer(seed,owner),"currency":"EUR","timezone":"Europe/Helsinki",
        "claimed_from":START,"claimed_to_exclusive":END,"files":sorted(files,key=lambda file:file["role"])}
    digest=json_file(output/"manifest.json",manifest)
    return {"transactions":count,"source_customer_ref":manifest["source_customer_ref"],"manifest_sha256":digest,
        "size_bytes":sum(file["size_bytes"] for file in files),"account_controls":controls,"row_features":statistics}


def generate(output,*,rows,users=1000,heavy_rows=100000,seed=SEED):
    counts=owner_counts(rows,users,heavy_rows,seed)
    output=Path(output)
    # Never clear/overwrite an earlier run. An interrupted directory remains
    # inspectable and lacks the final complete inventory.
    output.mkdir(parents=True,exist_ok=False)
    inventory=[]
    for owner,count in enumerate(counts):
        relative=f"owners/u{owner:05d}"
        entry=write_owner(output/relative,seed,owner,count)
        inventory.append({**entry,"path":relative,"fixture_tenant_id":str(uuid5(NAMESPACE,f"{seed}:tenant:{owner//100}")),
            "fixture_user_id":str(uuid5(NAMESPACE,f"{seed}:owner:{owner}"))})
    revised=write_owner(output/"variants/pending-booked",seed,0,counts[0],revision=True)
    invalid=write_owner(output/"variants/invalid-money",seed,0,20,malformed=True)
    index={"version":VERSION,"complete":True,"synthetic":True,"seed":seed,"base_transactions":rows,
        "users":users,"accounts_per_user":3,"accounts":users*3,"months":24,"coverage_from":START,
        "coverage_to_exclusive":END,"observed_at":OBSERVED,"heavy_owner":"owners/u00000","heavy_owner_rows":heavy_rows,
        "owners":inventory,"variants":[
            {**revised,"path":"variants/pending-booked","replaces":"owners/u00000","expected":"same_ids_one_pending_to_booked_revision",
                "changed_source_id":"tx-000000004","net_delta_minor":50,"observed_at":NEXT_OBSERVED},
            {**invalid,"path":"variants/invalid-money","expected":"row_rejection_and_failed_control_totals",
                "row_ordinal":8,"rejection_code":"invalid_integer"}],
        "replay":{"policy":"reuse_exact_owner_files_and_manifest","duplicates_in_base":False},
        "limitations":["Authored synthetic workloads, not organizer or customer data.",
            "Fixture owner identifiers never authorize runtime access; provision only through a trusted isolated test harness.",
            "Source flow and basket labels are claims. Native publication retains its existing unresolved-flow policy.",
            "Base row counts exclude separately listed revision/negative variants.",
            "No files are uploaded or published, and no model, banking or public-data provider is contacted.",
            "Generation is not an import, forecast, load, memory or production-capacity acceptance result."]}
    index_hash=json_file(output/"index.json",index)
    return index,index_hash


def verify(output,expected_index_sha256):
    """Verify a pinned inventory and every source hash with bounded reads."""
    if not re.fullmatch(r"[a-f0-9]{64}",expected_index_sha256): raise ValueError("Use a pinned lowercase SHA-256 index digest")
    root=Path(output).resolve()
    def local(path):
        resolved=path.resolve()
        if not resolved.is_relative_to(root): raise ValueError("A fixture path leaves the selected output directory")
        return resolved
    with local(root/"index.json").open("rb") as handle: raw=handle.read(2*1024**2+1)
    if len(raw)>2*1024**2 or hashlib.sha256(raw).hexdigest()!=expected_index_sha256:
        raise ValueError("The fixture index does not match its pinned digest")
    index=json.loads(raw)
    if index["version"]!=VERSION or index["complete"] is not True or index["synthetic"] is not True:
        raise ValueError("Only complete authored v1 scale inventories are supported")
    counts=owner_counts(index["base_transactions"],index["users"],index["heavy_owner_rows"],index["seed"])
    if len(index["owners"])!=len(counts) or index["accounts"]!=3*len(counts) or len(index["variants"])!=2:
        raise ValueError("Scale inventory cardinality does not reconcile")
    entries=[(entry,f"owners/u{owner:05d}",count) for owner,(entry,count) in enumerate(zip(index["owners"],counts))]
    entries.extend(zip(index["variants"],("variants/pending-booked","variants/invalid-money"),(counts[0],20)))
    checked_bytes=0
    for entry,relative,count in entries:
        if entry["path"]!=relative or entry["transactions"]!=count:
            raise ValueError("Scale package path or row allocation changed")
        folder=root/relative
        with local(folder/"manifest.json").open("rb") as handle: manifest_raw=handle.read(8193)
        if len(manifest_raw)>8192 or hashlib.sha256(manifest_raw).hexdigest()!=entry["manifest_sha256"]:
            raise ValueError("An owner manifest failed integrity verification")
        manifest=ImportManifestV1.model_validate_json(manifest_raw)
        if len(manifest.files)!=3 or sum(file.size_bytes for file in manifest.files)!=entry["size_bytes"]:
            raise ValueError("Owner file inventory does not reconcile")
        for file in manifest.files:
            size,lines=0,0
            digest=hashlib.sha256()
            with local(folder/f"{file.role}.csv").open("rb") as handle:
                header=handle.readline(65537)
                if header!=(",".join(COLUMNS[file.role])+"\n").encode("ascii"):
                    raise ValueError("Scale CSV header changed")
                while header:
                    digest.update(header);size+=len(header);lines+=header.count(b"\n")
                    header=handle.read(65536)
            # v1 generates no embedded newlines in fields. With pinned content
            # hashes this independent physical-line count is an exact row count.
            if size!=file.size_bytes or digest.hexdigest()!=file.sha256 or lines!=(count if file.role=="transactions" else 3)+1:
                raise ValueError("A scale CSV failed integrity or row-count verification")
            checked_bytes+=size
    return {"base_transactions":index["base_transactions"],"users":index["users"],"accounts":index["accounts"],
        "packages":len(entries),"csv_size_bytes":checked_bytes,"index_sha256":expected_index_sha256}


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--profile",choices=tuple(PROFILES))
    parser.add_argument("--output",type=Path,required=True,help="New output directory; existing paths are never overwritten")
    parser.add_argument("--seed",type=int,default=SEED)
    parser.add_argument("--verify",action="store_true",help="Read and verify an existing pinned inventory; do not generate")
    parser.add_argument("--expected-index-sha256")
    args=parser.parse_args()
    started=time.monotonic()
    if args.verify:
        if not args.expected_index_sha256 or args.profile: parser.error("Verification needs --expected-index-sha256 and no --profile")
        try: result=verify(args.output,args.expected_index_sha256)
        except (ValueError,OSError,KeyError,TypeError) as error: parser.error(str(error))
        print(json.dumps(result,sort_keys=True))
        return
    if not args.profile or args.expected_index_sha256: parser.error("Generation needs --profile and no index verification digest")
    try: index,digest=generate(args.output,rows=PROFILES[args.profile],seed=args.seed)
    except (ValueError,FileExistsError) as error: parser.error(str(error))
    print(f"Generated {index['base_transactions']} base rows, {index['users']} owners, {index['accounts']} accounts; "
        f"index SHA-256 {digest}; elapsed {time.monotonic()-started:.2f}s. Import/load acceptance was not run.")


if __name__=="__main__": main()
