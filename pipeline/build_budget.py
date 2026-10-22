#!/usr/bin/env python3
"""
Build the spending and revenue data for one fiscal year from Treasury's
Monthly Treasury Statement (MTS), via the free Fiscal Data API.

Usage:
    python3 pipeline/build_budget.py            # latest completed fiscal year
    python3 pipeline/build_budget.py --fy 2026  # a specific year
    python3 pipeline/build_budget.py --fy 2026 --offline   # reuse cached raw files

Writes:
    raw/fy<FY>/mts_table_{4,5,9}.json   cached API responses
    web/data/fy<FY>/spending.json       spending by agency (drill-down tree)
    web/data/fy<FY>/functions.json      spending by budget function (one level)
    web/data/fy<FY>/revenue.json        receipts by source (drill-down tree)
    web/data/manifest.json              list of available years

Uses only the Python standard library.
"""
import argparse, datetime, json, os, sys, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
API = "https://api.fiscaldata.treasury.gov/services/api/fiscal_service/v1/accounting/mts/"
CONFIG = json.load(open(os.path.join(ROOT, "pipeline", "config.json")))
TOL = 1e6  # reconciliation tolerance: $1 million


# ---------------------------------------------------------------- fetching
def fetch_table(table, record_date):
    url = (f"{API}{table}?filter=record_date:eq:{record_date}"
           f"&page[size]=10000")
    req = urllib.request.Request(url.replace("[", "%5B").replace("]", "%5D"),
                                 headers={"User-Agent": "federal-budget-viewer"})
    with urllib.request.urlopen(req, timeout=120) as resp:
        data = json.load(resp)
    rows = data["data"]
    if data["meta"]["total-count"] > len(rows):
        sys.exit(f"{table}: more rows than one page; add pagination")
    return rows


def latest_completed_fy():
    """Most recent fiscal year whose September statement is published."""
    today = datetime.date.today()
    fy = today.year if today.month >= 10 else today.year - 1
    for cand in (fy, fy - 1):
        if fetch_table("mts_table_9", f"{cand}-09-30"):
            return cand
    sys.exit("Could not find a completed fiscal year")


def load_raw(fy, offline):
    rawdir = os.path.join(ROOT, "raw", f"fy{fy}")
    os.makedirs(rawdir, exist_ok=True)
    out = {}
    for t in ("mts_table_4", "mts_table_5", "mts_table_9"):
        path = os.path.join(rawdir, f"{t}.json")
        if offline:
            rows = json.load(open(path))
        else:
            rows = fetch_table(t, f"{fy}-09-30")
            if not rows:
                sys.exit(f"No final (September) MTS data for FY{fy} yet")
            json.dump(rows, open(path, "w"))
        out[t] = rows
    return out


# ---------------------------------------------------------------- helpers
def num(v):
    return None if v in (None, "null", "") else float(v)


def clean(name):
    return name.strip().rstrip(":").strip()


def is_total(name):
    return name.lower().replace(" ", "").startswith("total--")


def raw_tree(rows, amount_fields):
    """Turn MTS rows (parent_id links) into nested dicts, dropping Total rows.
    amount_fields: dict of output key -> row field."""
    kids = {}
    for r in rows:
        kids.setdefault(r["parent_id"], []).append(r)

    pr = CONFIG.get("path_renames", {})

    def build(r, parent=""):
        name = clean(r["classification_desc"])
        node = {"name": pr.get(f"{parent} › {name}", name),
                "type": r["record_type_cd"],
                **{k: num(r[f]) for k, f in amount_fields.items()}}
        ch = sorted(kids.get(r["classification_id"], []),
                    key=lambda x: int(x["print_order_nbr"]))
        node["total_row"] = next(({k: num(c[f]) for k, f in amount_fields.items()}
                                  for c in ch if is_total(c["classification_desc"])), None)
        node["children"] = [build(c, name) for c in ch if not is_total(c["classification_desc"])]
        return node

    tops = sorted([r for r in kids.get("null", []) if r["record_type_cd"] != "SL"],
                  key=lambda x: int(x["print_order_nbr"]))
    return [build(r) for r in tops], rows


def rnd(x):
    return int(round(x))


# ---------------------------------------------------------------- spending
def pivot(agency, mapping):
    """Title > Branch  ->  Branch > Title (for DoD)."""
    branches, other = {}, []
    for title in agency["children"]:
        hit = False
        for g in title["children"]:
            if g["name"] in mapping:
                hit = True
                b = branches.setdefault(mapping[g["name"]],
                                        {"name": mapping[g["name"]], "amt": None, "children": []})
                b["children"].append({**g, "name": title["name"]})
        if not hit:
            other.append(title)
    order = list(dict.fromkeys(mapping.values()))
    agency["children"] = [branches[k] for k in order if k in branches] + other
    return agency


def classify_spending(nodes):
    ig = CONFIG["intragovernmental"]
    anc_names, item_names = set(ig["ancestor_names"]), set(ig["item_names"])
    renames = CONFIG["renames"]

    def walk(n, ancestors):
        name = n["name"]
        out = {"n": renames.get(name, name), "v": 0.0, "net": 0.0,
               "o": 0.0, "t": 0.0, "off": [], "xf": [], "c": []}
        kids = list(n["children"])
        if n.get("amt") is not None and kids:
            # a line with its own amount plus sub-lines: keep own amount as a child
            kids.insert(0, {"name": name, "amt": n["amt"], "children": []})
        if not kids:
            a = n.get("amt")
            if a is None or a == 0:
                return None
            transfer = (name in item_names or bool(anc_names & set(ancestors + [name])))
            out["net"] = a
            if transfer:
                out["t"] = a
                out["xf"].append({"n": out["n"], "v": a})
            elif a > 0:
                out["v"] = a
            else:
                out["o"] = a
                out["off"].append({"n": out["n"], "v": a})
            return out
        for k in kids:
            c = walk(k, ancestors + [name])
            if c is None:
                continue
            for f in ("v", "net", "o", "t"):
                out[f] += c[f]
            if c["v"] > 0:
                out["c"].append(c)
                # offsets/transfers inside a drawn child stay with that child
            else:
                for e in c["off"]:
                    out["off"].append({"n": e["n"] if e["n"] == c["n"] else f'{c["n"]} › {e["n"]}', "v": e["v"]})
                for e in c["xf"]:
                    out["xf"].append({"n": e["n"] if e["n"] == c["n"] else f'{c["n"]} › {e["n"]}', "v": e["v"]})
        # a child that duplicates its parent's name and is the only child collapses
        if len(out["c"]) == 1 and out["c"][0]["n"] == out["n"]:
            only = out["c"][0]
            out["c"] = only["c"]
            out["off"] += only["off"]
            out["xf"] += only["xf"]
        return out

    return [walk(n, []) for n in nodes]


def finalize(node):
    """Round, sort children by size, drop empty lists."""
    for f in ("v", "net", "o", "t"):
        node[f] = rnd(node.get(f, 0))
    for f in ("off", "xf", "c"):
        node.setdefault(f, [])
    node["off"] = sorted([{"n": e["n"], "v": rnd(e["v"])} for e in node["off"] if rnd(e["v"])],
                         key=lambda e: e["v"])
    node["xf"] = sorted([{"n": e["n"], "v": rnd(e["v"])} for e in node["xf"] if rnd(e["v"])],
                        key=lambda e: -abs(e["v"]))
    node["c"] = sorted([finalize(c) for c in node["c"]], key=lambda c: -c["v"])
    for f in ("off", "xf", "c"):
        if not node[f]:
            del node[f]
    for f in ("o", "t"):
        if not node[f]:
            del node[f]
    return node


def build_spending(t5):
    tree, rows = raw_tree(t5, {"amt": "current_fytd_net_outly_amt"})
    for a in tree:
        if a["name"] in CONFIG["pivot"]:
            pivot(a, CONFIG["pivot"][a["name"]])
    agencies = [a for a in classify_spending(tree) if a]
    root = {"n": "Federal spending", "v": 0.0, "net": 0.0, "o": 0.0, "t": 0.0,
            "off": [], "xf": [], "c": []}
    for a in agencies:
        for f in ("v", "net", "o", "t"):
            root[f] += a[f]
        if a["v"] > 0:
            root["c"].append(a)
        else:  # e.g. Undistributed Offsetting Receipts: all negative
            root["off"] += [{"n": f'{a["n"]} › {e["n"]}', "v": e["v"]} for e in a["off"]]
            root["xf"] += [{"n": f'{a["n"]} › {e["n"]}', "v": e["v"]} for e in a["xf"]]
    official = next(num(r["current_fytd_net_outly_amt"]) for r in rows
                    if r["record_type_cd"] == "SL" and clean(r["classification_desc"]) == "Total Outlays")
    if abs(root["net"] - official) > TOL:
        sys.exit(f"Spending does not reconcile: {root['net']:,.0f} vs official {official:,.0f}")
    return finalize(root), official


def build_functions(t9):
    rows = [r for r in t9 if r["record_type_cd"] == "F"]
    total = next(num(r["current_fytd_rcpt_outly_amt"]) for r in t9
                 if clean(r["classification_desc"]) == "Total" and r["record_type_cd"] == "SL"
                 and r["parent_id"] != "null")
    root = {"n": "Spending by function", "v": 0.0, "net": 0.0, "o": 0.0, "off": [], "c": []}
    for r in sorted(rows, key=lambda x: int(x["print_order_nbr"])):
        a = num(r["current_fytd_rcpt_outly_amt"]) or 0
        root["net"] += a
        if a > 0:
            root["v"] += a
            root["c"].append({"n": clean(r["classification_desc"]), "v": a, "net": a, "c": [],
                              "off": [], "xf": []})
        elif a < 0:
            root["o"] += a
            root["off"].append({"n": clean(r["classification_desc"]), "v": a})
    root["xf"], root["t"] = [], 0
    if abs(root["net"] - total) > TOL:
        sys.exit(f"Functions do not reconcile: {root['net']:,.0f} vs {total:,.0f}")
    return finalize(root)


# ---------------------------------------------------------------- revenue
def build_revenue(t4):
    fields = {"g": "current_fytd_gross_rcpt_amt", "r": "current_fytd_refund_amt",
              "net": "current_fytd_net_rcpt_amt"}
    tree, rows = raw_tree(t4, fields)

    def walk(n):
        out = {"n": n["name"], "v": 0.0, "net": 0.0, "o": 0.0, "off": [], "xf": [], "c": []}
        if not n["children"]:
            g, r = n["g"] or 0.0, n["r"] or 0.0
            if g > 0:
                out["v"] = g
            elif g < 0:
                out["o"] += g
                out["off"].append({"n": n["name"], "v": g})
            if r:
                out["o"] -= r
                out["off"].append({"n": "Refunds", "v": -r})
            out["net"] = g - r
            return out
        for k in n["children"]:
            c = walk(k)
            for f in ("v", "net", "o"):
                out[f] += c[f]
            if c["v"] > 0:
                out["c"].append(c)
            else:
                out["off"] += [{"n": e["n"] if e["n"] == c["n"] else f'{c["n"]} › {e["n"]}', "v": e["v"]}
                               for e in c["off"]]
        # refunds only reported on the Total row (e.g. individual income tax)
        tot = n.get("total_row")
        if tot and tot.get("r"):
            child_refunds = -sum(e["v"] for e in _all_offsets(out) if e["n"].endswith("Refunds"))
            missing = tot["r"] - child_refunds
            if abs(missing) > TOL:
                out["off"].append({"n": "Refunds", "v": -missing})
                out["o"] -= missing
                out["net"] -= missing
        if tot and tot.get("net") is not None and abs(out["net"] - tot["net"]) > TOL:
            sys.exit(f"Revenue line '{n['name']}' does not reconcile: "
                     f"{out['net']:,.0f} vs {tot['net']:,.0f}")
        return out

    root = {"n": "Federal revenue", "v": 0.0, "net": 0.0, "o": 0.0, "off": [], "xf": [], "c": []}
    for n in tree:
        c = walk(n)
        for f in ("v", "net", "o"):
            root[f] += c[f]
        root["c"].append(c)
    official = next(num(r["current_fytd_net_rcpt_amt"]) for r in rows
                    if r["record_type_cd"] == "SL" and clean(r["classification_desc"]) == "Total -- Receipts")
    if abs(root["net"] - official) > TOL:
        sys.exit(f"Revenue does not reconcile: {root['net']:,.0f} vs official {official:,.0f}")
    root["t"] = 0
    return finalize(root), official


def _all_offsets(node):
    out = list(node["off"])
    for c in node["c"]:
        out += _all_offsets(c)
    return out


# ---------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--fy", type=int)
    ap.add_argument("--offline", action="store_true", help="use cached raw/ files")
    args = ap.parse_args()
    fy = args.fy or latest_completed_fy()
    raw = load_raw(fy, args.offline)

    spending, outlays = build_spending(raw["mts_table_5"])
    functions = build_functions(raw["mts_table_9"])
    revenue, receipts = build_revenue(raw["mts_table_4"])

    meta = {"fy": fy, "record_date": f"{fy}-09-30",
            "generated": datetime.date.today().isoformat(),
            "outlays": rnd(outlays), "receipts": rnd(receipts),
            "deficit": rnd(receipts - outlays),
            "source": "U.S. Treasury, Monthly Treasury Statement (final, September), "
                      "via api.fiscaldata.treasury.gov",
            "links": {
                "dataset": "https://fiscaldata.treasury.gov/datasets/monthly-treasury-statement/",
                "spending": f"{API}mts_table_5?filter=record_date:eq:{fy}-09-30&page[size]=10000",
                "functions": f"{API}mts_table_9?filter=record_date:eq:{fy}-09-30&page[size]=10000",
                "revenue": f"{API}mts_table_4?filter=record_date:eq:{fy}-09-30&page[size]=10000",
            }}
    outdir = os.path.join(ROOT, "web", "data", f"fy{fy}")
    os.makedirs(outdir, exist_ok=True)
    for name, obj in (("spending", spending), ("functions", functions), ("revenue", revenue)):
        json.dump({"meta": meta, "tree": obj}, open(os.path.join(outdir, f"{name}.json"), "w"),
                  separators=(",", ":"))

    # manifest: one entry per year folder found
    mpath = os.path.join(ROOT, "web", "data", "manifest.json")
    manifest = json.load(open(mpath)) if os.path.exists(mpath) else {"years": []}
    years = {y["fy"]: y for y in manifest["years"]}
    years[fy] = {**years.get(fy, {}), "fy": fy, "budget": True,
                 "outlays": meta["outlays"], "receipts": meta["receipts"]}
    manifest["years"] = sorted(years.values(), key=lambda y: -y["fy"])
    json.dump(manifest, open(mpath, "w"), indent=2)

    b = 1e9
    print(f"FY{fy}  receipts ${receipts/b:,.1f}B  outlays ${outlays/b:,.1f}B  "
          f"deficit ${(receipts-outlays)/b:,.1f}B")
    print(f"  spending to the public (gross) ${spending['v']/b:,.1f}B, "
          f"offsetting receipts ${spending.get('o',0)/b:,.1f}B, "
          f"intragovernmental net ${spending.get('t',0)/b:,.1f}B")
    print(f"  revenue gross ${revenue['v']/b:,.1f}B, refunds/adjustments ${revenue.get('o',0)/b:,.1f}B")
    print(f"  wrote {outdir}")


if __name__ == "__main__":
    main()
