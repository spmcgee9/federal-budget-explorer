#!/usr/bin/env python3
"""
Parse the DoD Comptroller's budget exhibits ("display" Excel files) into line items.

Usage:
    python3 pipeline/parse_dod_exhibits.py --request-year 2027 --dir raw/dod

Looks in --dir for FY<N>_<exhibit>_display.xlsx, for any of:
    p1   procurement            (budget line items; quantities)
    p1r  Guard/Reserve shares of procurement lines (memo only; annotates p1 items)
    r1   RDT&E                  (program elements)
    o1   operation & maintenance (sub-activity groups, grouped by activity group)
    m1   military personnel      (pay categories)
    c1   military construction   (projects, grouped by state/country)
    rf1  revolving funds         (working capital fund appropriations)

Each FY<N> exhibit carries FY<N-2> actual, FY<N-1> enacted (with any reconciliation spend
plan) and FY<N> request. Amounts in the files are thousands of dollars; output is dollars.
Writes raw/dod/exhibits_fy<N>.json. Requires: pip install openpyxl
"""
import argparse, json, os, re, sys
import openpyxl

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CFG = json.load(open(os.path.join(ROOT, "pipeline", "dod_config.json")))


def norm(s):
    s = re.sub(r"[^A-Z0-9 ]", " ", str(s or "").upper()).replace("DEVELOPEMENT", "DEVELOPMENT")
    return " ".join(s.split())


def clean(s):
    return " ".join(str(s or "").split())


def sheet_rows(path, sheet=None):
    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    out = {}
    for ws in wb.worksheets if sheet is None else [w for w in wb.worksheets if w.title.startswith(sheet)][:1]:
        it = ws.iter_rows(values_only=True)
        hdr = None
        for r in it:
            if r and r[0] == "Account":
                hdr = [clean(h) for h in r]
                break
        if hdr:
            out[ws.title] = (hdr, [dict(zip(hdr, r)) for r in it if r and r[0]])
    if not out:
        sys.exit(f"{path}: no sheet with an 'Account' header row")
    return out


def col(hdr, *must, required=True):
    for h in hdr:
        if all(m.lower() in h.lower() for m in must):
            return h
    if required:
        sys.exit(f"Column containing {must} not found; headers are: {hdr}")
    return None


def amt(x):
    return float(x) * 1000 if isinstance(x, (int, float)) else 0.0


def keys_for(code):
    """'3010F' -> ('057-3010', '097-3010'); '493001A' -> ('021-4930', '097-4930')"""
    m = re.match(r"(\d{4})\d*([A-Z])$", code or "")
    if not m:
        return None, None
    ag = CFG["exhibit_suffix"].get(m.group(2))
    return (f"{ag}-{m.group(1)}" if ag else None), f"097-{m.group(1)}"


class Book:
    def __init__(self):
        self.accounts = {}

    def add(self, kind, code, title, ba_num, ba_title, item):
        if not code:
            return
        key, alt = keys_for(code)
        a = self.accounts.setdefault(code, {"key": key, "alt": alt, "title": clean(title), "kind": kind,
                                            "ba_titles": {}, "bas": {}})
        if ba_title:
            a["ba_titles"].setdefault(ba_num, clean(ba_title))
        a["bas"].setdefault(ba_num, []).append(item)


def three_year(r, cols):
    return {"fy_prev": amt(r[cols["prev"]]), "fy_mid": amt(r[cols["mid"]]),
            "fy_req": amt(r[cols["req"]]), "fy_mid_disc": amt(r[cols["disc"]]) if cols.get("disc") else None}


def parse_simple(book, kind, path, sheet, N, id_col, name_col, grp_col=None, amount_word="Total"):
    """R-1, O-1, M-1, RF-1: one row per line item (M-1 also has Add/Non-Add)."""
    (hdr, rows), = sheet_rows(path, sheet).values()
    cols = {"prev": col(hdr, f"FY {N-2} {amount_word}"), "mid": col(hdr, f"FY {N-1} {amount_word}"),
            "req": col(hdr, f"FY {N} {amount_word}"), "disc": col(hdr, f"FY {N-1} Discretionary", required=False)}
    for r in rows:
        if r.get("Include In TOA") not in ("Y", None) or r.get("Add/Non-Add") not in ("Add", None):
            continue
        it = {"n": clean(r[name_col]), "id": clean(r[id_col]), **three_year(r, cols)}
        if grp_col and clean(r.get(grp_col)) not in ("", "-"):
            it["grp"] = clean(r[grp_col])
        book.add(kind, r["Account"], r["Account Title"], r["Budget Activity"], r["Budget Activity Title"], it)


def parse_p1(book, path, N, p1r_path=None):
    (hdr, rows), = sheet_rows(path, "Exhibit P-1").values()
    cols = {"prev": col(hdr, f"FY {N-2} Total Amount"), "mid": col(hdr, f"FY {N-1} Total Amount"),
            "req": col(hdr, f"FY {N} Total Amount"), "disc": col(hdr, f"FY {N-1} Discretionary", "Amount")}
    qcol = col(hdr, f"FY {N-1} Total Quantity")
    items = {}
    for r in rows:
        if r.get("Add/Non-Add") != "Add":
            continue
        k = (r["Account"], r["Budget Activity"], r["Budget Line Item"])
        it = items.setdefault(k, {"n": clean(r["Budget Line Item (BLI) Title"]), "id": clean(r["Budget Line Item"]),
                                  "_t": (r["Account Title"], r["Budget Activity Title"]),
                                  "fy_prev": 0.0, "fy_mid": 0.0, "fy_req": 0.0, "fy_mid_disc": 0.0})
        for f, v in three_year(r, cols).items():
            it[f] += v or 0
        if r.get("Cost Type Title") == "Weapon System Cost" and isinstance(r[qcol], (int, float)):
            it["qty"] = int(r[qcol])
    # Guard / Reserve shares (memo amounts, already included in the P-1 totals)
    if p1r_path and os.path.exists(p1r_path):
        (h2, r2), = sheet_rows(p1r_path, "Exhibit P-1R").values()
        mid = col(h2, f"FY {N-1} Total Amount")
        for r in r2:
            k = (r["Account"], r["Budget Activity"], r["Budget Line Item"])
            if k in items and amt(r[mid]):
                f = "ng" if "Guard" in str(r.get("Cost Type Title")) else "rsv"
                items[k][f] = items[k].get(f, 0) + amt(r[mid])
    for (code, ba, _), it in items.items():
        title, ba_title = it.pop("_t")
        book.add("p1", code, title, ba, ba_title, it)


def parse_c1(book, path, N):
    sheets = sheet_rows(path)
    def amounts(sheet_name_start):
        out = {}
        for name, (hdr, rows) in sheets.items():
            if not name.replace(" ", "").startswith(sheet_name_start.replace(" ", "")):
                continue
            toa = col(hdr, "TOA Amount", required=False) or col(hdr, "Total Obligation Authority")
            for r in rows:
                k = (r["Account"], clean(r.get("Construction Project")), clean(r.get("Location Title")))
                rec = out.setdefault(k, {"r": r, "v": 0.0})
                rec["v"] += amt(r[toa])
        return out
    prev, mid, req = amounts(f"FY {N-2}"), amounts(f"FY {N-1}"), amounts(f"FY {N}")
    mid_rec = amounts(f"FY{N-1} Mandatory")
    req_rec = amounts(f"FY{N} Mandatory")
    keys = set(mid) | set(mid_rec) | set(prev) | set(req) | set(req_rec)
    for k in keys:
        src = (mid.get(k) or mid_rec.get(k) or req.get(k) or req_rec.get(k) or prev.get(k))["r"]
        m_disc = mid.get(k, {}).get("v", 0.0)
        it = {"n": clean(f"{src.get('Location Title')}: {src.get('Construction Project Title')}"),
              "id": k[1], "grp": clean(src.get("State Country Title")) or "Unspecified location",
              "fy_prev": prev.get(k, {}).get("v", 0.0), "fy_mid": m_disc + mid_rec.get(k, {}).get("v", 0.0),
              "fy_mid_disc": m_disc, "fy_req": req.get(k, {}).get("v", 0.0) + req_rec.get(k, {}).get("v", 0.0),
              "project": True}
        book.add("c1", src["Account"], src["Account Title"], src["Budget Activity"], src["Budget Activity Title"], it)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--request-year", type=int, required=True)
    ap.add_argument("--dir", default=os.path.join(ROOT, "raw", "dod"))
    a = ap.parse_args()
    N, d = a.request_year, a.dir
    f = lambda k: os.path.join(d, f"FY{N}_{k}_display.xlsx")
    book = Book()
    if os.path.exists(f("p1")):
        parse_p1(book, f("p1"), N, f("p1r"))
    if os.path.exists(f("r1")):
        parse_simple(book, "r1", f("r1"), "Exhibit R-1", N, "PE/BLI", "Program Element/Budget Line Item (BLI) Title")
    if os.path.exists(f("o1")):
        parse_simple(book, "o1", f("o1"), "OM Title", N, "SAG/BLI", "SAG/Budget Line Item (BLI) Title",
                     grp_col="AG/Budget SubActivity (BSA) Title")
    if os.path.exists(f("m1")):
        parse_simple(book, "m1", f("m1"), "Exhibit M-1", N, "BSA", "Budget SubActivity (BSA) Title")
    if os.path.exists(f("rf1")):
        parse_simple(book, "rf1", f("rf1"), "RF-1 Title", N, "SAG/BLI", "SAG/Budget Line Item (BLI) Title")
    if os.path.exists(f("c1")):
        parse_c1(book, f("c1"), N)

    out = {"_columns": {"prev": f"FY {N-2} actual", "mid": f"FY {N-1} enacted", "req": f"FY {N} request"},
           "_request_year": N, "accounts": {}}
    totals = {}
    for code, acc in book.accounts.items():
        bas = {}
        for ba_num, items in acc["bas"].items():
            t = norm(acc["ba_titles"].get(ba_num, f"BUDGET ACTIVITY {ba_num}"))
            keep = []
            for i in items:
                if not any(i.get(x) for x in ("fy_prev", "fy_mid", "fy_req")):
                    continue
                for x in ("fy_prev", "fy_mid", "fy_req", "fy_mid_disc", "ng", "rsv"):
                    if i.get(x) is not None:
                        i[x] = round(i[x])
                keep.append(i)
            if keep:
                bas.setdefault(t, []).extend(keep)
        if bas:
            out["accounts"][code] = {k: acc[k] for k in ("key", "alt", "title", "kind")}
            out["accounts"][code]["bas"] = {t: sorted(v, key=lambda i: -i["fy_mid"]) for t, v in bas.items()}
            totals[acc["kind"]] = totals.get(acc["kind"], 0) + sum(i["fy_mid"] for v in bas.values() for i in v)
    path = os.path.join(ROOT, "raw", "dod", f"exhibits_fy{N}.json")
    json.dump(out, open(path, "w"), indent=1)
    for k, v in totals.items():
        print(f"  {k}: FY{N-1} enacted ${v/1e9:,.1f}B")
    print(f"{len(out['accounts'])} accounts; wrote {path}")


if __name__ == "__main__":
    main()
