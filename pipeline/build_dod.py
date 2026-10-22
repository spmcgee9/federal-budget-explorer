#!/usr/bin/env python3
"""
Add Defense detail beneath the Treasury spending tree.

Run after build_budget.py, fetch_dod_outlays.py and parse_dod_exhibits.py:
    python3 pipeline/build_dod.py --fy 2026 --exhibits 2027

Adds, under  Department of Defense (Military) › <service> › <appropriation title>:
    account              actual outlays (USAspending), scaled to Treasury's full-year net total
      budget activity    actual outlays, same scaling
        [group]          optional grouping (O&M activity group, construction state/country)
          line item      FY<N-1> ENACTED FUNDING from the budget exhibits, with the prior-year
                         actual and the next-year request alongside

Why the scaling: USAspending lags Treasury by a month or two and reports gross outlays.
Reimbursable activity (work done for, and paid back by, other customers) is removed, then each
account's share of what remains is applied to Treasury's full-year net total for the title, so
the boxes always add up to the published figure. With a full year reported the factor is ~1.
"""
import argparse, json, os, re, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CFG = json.load(open(os.path.join(ROOT, "pipeline", "dod_config.json")))
UNASSIGNED = ("UNDISTRIBUTED", "UNIDENTIFIED", "UNDISTRIBUTED DIRECT PROGRAM ACTIVITY", "UNKNOWN/OTHER")


def norm(s):
    s = re.sub(r"[^A-Z0-9 ]", " ", str(s or "").upper()).replace("DEVELOPEMENT", "DEVELOPMENT")
    return " ".join(s.split())


def title_case(s):
    small = {"and", "of", "or", "the", "for", "in", "to", "a", "on"}
    words = s.lower().split()
    return " ".join(w if (i and w in small) else w[:1].upper() + w[1:] for i, w in enumerate(words))


def tas_year(code):
    m = re.match(r"\d{3}-(\d{4})(?:/\d{4})?-", code)
    return int(m.group(1)) if m else None


def find(node, name, required=True):
    for c in node.get("c", []):
        if c["n"] == name:
            return c
    if required:
        sys.exit(f"'{name}' not found under '{node['n']}' in spending.json")
    return None


def classify(name):
    for rule in CFG["title_rules"]:
        if any(w.lower() in name.lower() for w in rule["any"]):
            return rule["title"]
    return None


def best_match(key, titles):
    """Exact match first, then prefix, then the best word overlap (>= 60%)."""
    if key in titles:
        return key
    for t in titles:
        if t.startswith(key) or key.startswith(t):
            return t
    kw = set(key.split())
    best, score = None, 0.0
    for t in titles:
        tw = set(t.split())
        j = len(kw & tw) / max(1, len(kw | tw))
        if j > score:
            best, score = t, j
    return best if score >= 0.6 else None


def item_node(i):
    n = {"n": i["n"], "v": max(0, i["fy_mid"]), "net": i["fy_mid"], "basis": "ba", "pe": i.get("id"),
         "fy_prev": i.get("fy_prev"), "fy_mid": i["fy_mid"], "fy_mid_disc": i.get("fy_mid_disc"), "fy_req": i.get("fy_req")}
    for k in ("qty", "ng", "rsv", "project"):
        if i.get(k):
            n[k] = i[k]
    return n


def items_tree(items):
    nodes = [item_node(i) for i in items]
    grps = {i.get("grp") for i in items if i.get("grp")}
    many = len(items) >= CFG.get("group_min_items", 12) or any(i.get("project") for i in items)
    if len(grps) > 1 and many:
        by = {}
        for i, n in zip(items, nodes):
            by.setdefault(i.get("grp") or "Other", []).append(n)
        out = []
        for g, kids in by.items():
            kids.sort(key=lambda x: -x["v"])
            s = lambda f: sum((k.get(f) or 0) for k in kids)
            out.append({"n": g, "v": s("v"), "net": s("fy_mid"), "basis": "ba", "grp": True,
                        "fy_prev": s("fy_prev"), "fy_mid": s("fy_mid"), "fy_req": s("fy_req"), "c": kids})
        return sorted(out, key=lambda x: -x["v"])
    return sorted(nodes, key=lambda x: -x["v"])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--fy", type=int, required=True)
    ap.add_argument("--exhibits", type=int, help="budget-request year of the exhibits (e.g. 2027)")
    a = ap.parse_args()

    spath = os.path.join(ROOT, "web", "data", f"fy{a.fy}", "spending.json")
    doc = json.load(open(spath))
    out = json.load(open(os.path.join(ROOT, "raw", "dod", f"outlays_fy{a.fy}.json")))

    # exhibit line items, merged per USAspending account
    ex_by_acct, cols = {}, None
    if a.exhibits:
        ex = json.load(open(os.path.join(ROOT, "raw", "dod", f"exhibits_fy{a.exhibits}.json")))
        cols = ex["_columns"]
        for code, acc in ex["accounts"].items():
            target = acc["key"] if acc["key"] in out["accounts"] else acc["alt"]
            for t, items in acc["bas"].items():
                ex_by_acct.setdefault(target, {}).setdefault(t, []).extend(items)

    # sort accounts into service / title
    plan, unclassified = {}, []
    for code, acct in out["accounts"].items():
        svc = CFG["services"].get(code[:3])
        title = classify(acct["name"])
        if not svc or not title:
            unclassified.append(f"{code} {acct['name']} (${(acct['gross_outlays'] or 0)/1e9:,.2f}B)")
            continue
        plan.setdefault((svc, title), []).append(code)

    dod = find(doc["tree"], CFG["dod_node"])
    aliases = CFG.get("ba_aliases", {})
    report = []
    for (svc_name, title_name), codes in sorted(plan.items()):
        svc_node = find(dod, svc_name, required=False)
        tnode = find(svc_node, title_name, required=False) if svc_node else None
        if not tnode or tnode["v"] <= 0:
            report.append(f"  skip {svc_name} › {title_name}: not in Treasury data ({len(codes)} accounts)")
            continue
        total = tnode["v"]
        if title_name in CFG.get("exhibit_only_titles", []):
            items = [i for code in codes for lst in ex_by_acct.get(code, {}).values() for i in lst]
            if items:
                tnode["c"] = items_tree(items)
                tnode["detail"] = {"exhibit_only": True, "exhibits": a.exhibits}
                report.append(f"  {svc_name} › {title_name}: ${total/1e9:,.1f}B, shown with exhibit amounts only (fund outlays are gross of sales)")
            continue
        built = []
        for code in codes:
            acct = out["accounts"][code]
            pas, years = {}, {}
            for t in acct["tas"]:
                for p in t["program_activities"]:
                    v = p["gross_outlays"] or 0
                    if "REIMBURSABLE" in p["name"].upper():
                        continue
                    key = norm(p["name"])
                    if key in UNASSIGNED or key.startswith("ACTIVITY FROM OBLIGATION BEFORE"):
                        key = "UNASSIGNED"
                    pas[key] = pas.get(key, 0) + v
                    y = tas_year(t["code"])
                    years[y] = years.get(y, 0) + v
            built.append((code, acct, pas, years))
        raw_total = sum(max(0, v) for _, _, pas, _ in built for v in pas.values())
        if raw_total <= 0:
            continue
        k = total / raw_total
        gap = 0
        if k > CFG.get("max_scale", 1.2) and out["period"]:
            k = 12 / out["period"]
            gap = total - raw_total * k
        children, unmatched = [], []
        for code, acct, pas, years in built:
            exb = ex_by_acct.get(code, {})
            used = set()
            bas = []
            for key, v in pas.items():
                if v <= 0:
                    continue
                name = "Not assigned to a budget activity" if key == "UNASSIGNED" else title_case(key)
                ba = {"n": name, "v": round(v * k), "net": round(v * k), "usa": round(v), "basis": "outlay"}
                if key != "UNASSIGNED" and exb:
                    t = aliases.get(f"{code}|{key}", aliases.get(key, key))
                    t = t if t in exb else best_match(key, list(exb))
                    if t:
                        ba["c"] = items_tree(exb[t])
                        used.add(t)
                    elif "CURRENCY FLUCTUATION" not in key:
                        unmatched.append(f"{code} '{key}'")
                bas.append(ba)
            # an account with exhibit lines but only one budget activity reported: attach all of them
            if exb and not used and len([b for b in bas if b["n"] != "Not assigned to a budget activity"]) <= 1 and bas:
                target = max(bas, key=lambda b: b["v"])
                target["c"] = items_tree([i for lst in exb.values() for i in lst])
            av = sum(b["v"] for b in bas)
            if av <= 0:
                continue
            children.append({"n": CFG["account_names"].get(code, acct["name"]), "code": code, "v": av, "net": av,
                             "usa": round(sum(max(0, v) for v in pas.values())), "basis": "outlay",
                             "from": [{"y": y, "v": round(v)} for y, v in sorted(years.items(), key=lambda x: -(x[0] or 0)) if v > 0.5e6],
                             "c": sorted(bas, key=lambda b: -b["v"])})
        if gap > 0:
            children.append({"n": "Not itemized in public account data", "v": round(gap), "net": round(gap),
                             "basis": "outlay", "gap": True})
        drift = total - sum(c["v"] for c in children)
        if children:
            children.sort(key=lambda c: -c["v"])
            children[0]["v"] += drift; children[0]["net"] += drift
            if children[0].get("c"):
                children[0]["c"][0]["v"] += drift; children[0]["c"][0]["net"] += drift
        tnode["c"] = children
        tnode["detail"] = {"period": out["period"], "scale": round(k, 4), "exhibits": a.exhibits, "gap": round(gap)}
        flag = f"   not itemized: ${gap/1e9:,.1f}B" if gap > 0 else ("" if k >= 0.95 else "   <-- check coverage")
        report.append(f"  {svc_name} › {title_name}: ${total/1e9:,.1f}B, {len(children)} accounts, scale {k:.3f}{flag}")
        for u in unmatched:
            report.append(f"      no exhibit match: {u}")

    meta = doc["meta"]
    meta.setdefault("links", {})
    meta["dod_outlays"] = {"fy": a.fy, "period": out["period"], "built": __import__("datetime").date.today().isoformat()}
    if a.exhibits:
        meta["dod_exhibits"] = {"request_year": a.exhibits, "columns": cols}
        base = f"https://comptroller.war.gov/Portals/45/Documents/defbudget/FY{a.exhibits}/FY{a.exhibits}"
        meta["links"].update({"dod_p1": base + "_p1.pdf", "dod_r1": base + "_r1.pdf", "dod_o1": base + "_o1.pdf",
                              "dod_m1": base + "_m1.pdf", "dod_c1": base + "_c1.pdf", "dod_rf1": base + "_rf1.pdf"})
    json.dump(doc, open(spath, "w"), separators=(",", ":"))
    print("\n".join(report))
    if unclassified:
        print("  accounts not assigned to a title (add a rule in dod_config.json if they matter):")
        for u in sorted(unclassified):
            print("    " + u)
    print(f"wrote {spath}")


if __name__ == "__main__":
    main()
