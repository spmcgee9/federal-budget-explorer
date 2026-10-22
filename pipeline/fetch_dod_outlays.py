#!/usr/bin/env python3
"""
Fetch actual outlays for Defense accounts from USAspending.gov, broken down by
sub-account (year of appropriation) and by program activity (= budget activity).

Usage:
    python3 pipeline/fetch_dod_outlays.py --fy 2026

Fetches every DoD military account whose Treasury agency code is listed under "services"
in pipeline/dod_config.json. Writes raw/dod/outlays_fy<FY>.json. Standard library only.
"""
import argparse, concurrent.futures as cf, json, os, sys, time, urllib.parse, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
API = "https://api.usaspending.gov/api/v2/"
CFG = json.load(open(os.path.join(ROOT, "pipeline", "dod_config.json")))


def get(path, params=None):
    url = API + path + ("?" + urllib.parse.urlencode(params) if params else "")
    for attempt in range(8):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "federal-budget-explorer"})
            with urllib.request.urlopen(req, timeout=120) as r:
                return json.load(r)
        except Exception as e:  # retry transient API errors with exponential back-off
            if attempt == 7:
                sys.exit(f"USAspending request failed: {url}\n{e}")
            time.sleep(min(60, 2 ** (attempt + 1)))


def latest_period(fy):
    periods = get("references/submission_periods/")["available_periods"]
    months = [p["submission_fiscal_month"] for p in periods if p["submission_fiscal_year"] == fy]
    return max(months) if months else None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--fy", type=int, required=True)
    a = ap.parse_args()
    prefixes = {k for k in CFG["services"] if not k.startswith("_")}

    results, page = [], 1
    while True:
        data = get(f"agency/{CFG['usaspending_agency']}/federal_account/",
                   {"fiscal_year": a.fy, "limit": 100, "page": page})
        results += data["results"]
        if not data["page_metadata"].get("hasNext"):
            break
        page += 1
    accounts = [x for x in results if x["code"][:3] in prefixes and (x["gross_outlay_amount"] or 0) != 0]
    jobs = [(acct["code"], t) for acct in accounts for t in acct["children"] if (t.get("gross_outlay_amount") or 0) != 0]
    print(f"{len(accounts)} accounts with outlays, {len(jobs)} sub-accounts to fetch")

    def fetch(job):
        code, t = job
        pa = get(f"agency/treasury_account/{t['code']}/program_activity/", {"fiscal_year": a.fy, "limit": 100})
        return code, {"code": t["code"], "gross_outlays": t["gross_outlay_amount"],
                      "program_activities": [{"name": r["name"], "gross_outlays": r["gross_outlay_amount"],
                                              "obligations": r["obligated_amount"]} for r in pa["results"]]}

    out = {"fy": a.fy, "period": latest_period(a.fy), "accounts": {
        x["code"]: {"name": x["name"], "gross_outlays": x["gross_outlay_amount"],
                    "obligations": x["obligated_amount"], "tas": []} for x in accounts}}
    with cf.ThreadPoolExecutor(max_workers=4) as pool:
        for i, (code, rec) in enumerate(pool.map(fetch, jobs), 1):
            out["accounts"][code]["tas"].append(rec)
            if i % 50 == 0:
                print(f"  {i}/{len(jobs)}", flush=True)
    path = os.path.join(ROOT, "raw", "dod", f"outlays_fy{a.fy}.json")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    json.dump(out, open(path + ".tmp", "w"), indent=1)
    os.replace(path + ".tmp", path)
    print(f"FY{a.fy} through fiscal month {out['period']}: wrote {path}")


if __name__ == "__main__":
    main()
