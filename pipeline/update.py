#!/usr/bin/env python3
"""
One command to refresh everything that can be refreshed automatically.

    python3 pipeline/update.py                 # latest completed fiscal year
    python3 pipeline/update.py --fy 2026       # a specific year
    python3 pipeline/update.py --states-ffy 2025 --states-url <Comptroller workbook link>

Steps:
  1. Treasury spending and revenue for the fiscal year (build_budget.py)
  2. Defense detail, when DoD budget exhibits for the matching request year are in raw/dod/
     (fetch_dod_outlays.py, parse_dod_exhibits.py, build_dod.py). Without exhibits, Defense
     still gets account and budget-activity detail from USAspending.
  3. State data, only when --states-ffy and --states-url are given (build_states.py)

If a refreshed file differs from the existing one only in its build dates, the existing file is
kept, so scheduled runs do not create empty commits.
Any reconciliation failure stops the run with an error (and fails the GitHub Action).
"""
import argparse, glob, json, os, re, subprocess, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "web", "data")
PY = sys.executable
DATE_KEYS = {"generated", "built"}


def run(*args):
    print("\n$ " + " ".join(os.path.relpath(a, ROOT) if os.path.isabs(a) else a for a in args), flush=True)
    subprocess.run([PY, *args], check=True, cwd=ROOT)


def strip_dates(x):
    if isinstance(x, dict):
        return {k: strip_dates(v) for k, v in x.items() if k not in DATE_KEYS}
    if isinstance(x, list):
        return [strip_dates(v) for v in x]
    return x


def snapshot():
    snap = {}
    for p in glob.glob(os.path.join(DATA, "**", "*.json"), recursive=True):
        with open(p, "rb") as f:
            snap[p] = f.read()
    return snap


def keep_if_only_dates_changed(before):
    kept = 0
    for p, old in before.items():
        if not os.path.exists(p):
            continue
        with open(p, "rb") as f:
            new = f.read()
        if new == old:
            continue
        try:
            if strip_dates(json.loads(new)) == strip_dates(json.loads(old)):
                with open(p, "wb") as f:
                    f.write(old)
                kept += 1
        except ValueError:
            pass
    return kept


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--fy", type=int, help="fiscal year (default: latest completed)")
    ap.add_argument("--states-ffy", type=int)
    ap.add_argument("--states-url")
    a = ap.parse_args()

    before = snapshot()

    # 1. Treasury
    run(os.path.join(ROOT, "pipeline", "build_budget.py"), *(["--fy", str(a.fy)] if a.fy else []))
    manifest = json.load(open(os.path.join(DATA, "manifest.json")))
    fy = a.fy or max(y["fy"] for y in manifest["years"] if y.get("budget"))

    # 2. Defense
    req_years = sorted({int(m.group(1)) for f in glob.glob(os.path.join(ROOT, "raw", "dod", "FY*_display.xlsx"))
                        if (m := re.search(r"FY(\d{4})_", os.path.basename(f)))})
    cache = os.path.join(ROOT, "raw", "dod", f"outlays_fy{fy}.json")
    try:
        run(os.path.join(ROOT, "pipeline", "fetch_dod_outlays.py"), "--fy", str(fy))
    except subprocess.CalledProcessError:
        if not os.path.exists(cache):
            raise
        print(f"\nWarning: USAspending download failed; using the previous download ({os.path.relpath(cache, ROOT)}).")
    if fy + 1 in req_years:
        run(os.path.join(ROOT, "pipeline", "parse_dod_exhibits.py"), "--request-year", str(fy + 1))
        run(os.path.join(ROOT, "pipeline", "build_dod.py"), "--fy", str(fy), "--exhibits", str(fy + 1))
    else:
        print(f"\nNote: no FY{fy + 1} budget exhibits in raw/dod/ (found: {req_years or 'none'}). "
              f"Defense detail stops at budget activities until they are added.")
        run(os.path.join(ROOT, "pipeline", "build_dod.py"), "--fy", str(fy))

    # 3. States (only when asked)
    if a.states_ffy and a.states_url:
        run(os.path.join(ROOT, "pipeline", "build_states.py"), "--ffy", str(a.states_ffy), "--url", a.states_url)

    kept = keep_if_only_dates_changed(before)
    print(f"\nDone. {kept} file(s) unchanged apart from build dates were left as they were.")


if __name__ == "__main__":
    main()
