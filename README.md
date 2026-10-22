# Federal Budget Explorer

An interactive, drill-down view of where federal money goes and where it comes from, built from what the government actually collected and spent.

- **Spending**: agency → bureau → account, from Treasury's year-end statement. Defense goes much deeper, to individual programs, pay categories and construction projects.
- **Revenue**: tax and other receipts by source, showing gross collections vs. refunds.
- **Purpose**: spending grouped by budget function.
- **By state**: a map of federal taxes paid vs. spending received for each state, per person or total, as reported or deficit-adjusted.
- **Search** across every line, revenue source and state ("F35", "Medicaid", "Virginia class").

Sources, methods and limitations are explained on the site's **About & methods** page (`web/about.html`).

Contact: smcgee.dev@gmail.com

---

## Repository layout

```
web/                     the website (static files; this folder is what gets published)
  index.html, app.js, styles.css, about.html
  data/manifest.json     which years exist (drives the year selector)
  data/fy<YEAR>/         spending, revenue and budget-function data
  data/states/           state data
  data/descriptions.json plain-language descriptions shown in the side panel (edit freely)
  data/geo/              U.S. state shapes
pipeline/                scripts that build web/data from the sources
  update.py              runs everything that can run automatically (used by the GitHub Action)
  build_budget.py        Treasury spending and revenue
  fetch_dod_outlays.py   Defense outlays by account and budget activity (USAspending.gov)
  parse_dod_exhibits.py  Defense programs from the DoD budget exhibits (Excel)
  build_dod.py           combines the two under Treasury's Defense totals
  build_states.py        state data from the NY State Comptroller's workbook
  config.json            Treasury naming and double-counting rules
  dod_config.json        Defense account and naming rules
raw/                     inputs: hand-downloaded Excel files, plus the last USAspending download
.github/workflows/       the monthly update and deploy job
```

## How updates work

### Automatic (monthly)

On the 20th of each month the GitHub Action:

1. Rebuilds Treasury spending and revenue for the latest completed fiscal year. A new year appears automatically each October, after Treasury publishes its final September statement.
2. Re-downloads Defense outlays from USAspending and rebuilds the Defense detail.
3. Commits any changed data and redeploys the site.

If the numbers fail to reconcile, the run stops without publishing and GitHub emails you. The usual cause is that Treasury renamed a line; the fix is normally a one-line edit to `pipeline/config.json`.

### By hand (about twice a year)

| When | What | How |
|---|---|---|
| Spring, after the President's budget request | New DoD budget exhibits | From comptroller.war.gov → Budget Materials → the new fiscal year, download the Excel ("display") versions of P-1, P-1R, R-1, O-1, M-1, C-1 and RF-1. Save them in `raw/dod/` as `FY<year>_p1_display.xlsx`, `FY<year>_r1_display.xlsx` and so on, then commit. The next run uses them for the fiscal year before the request year (FY2028 exhibits for FY2027 spending). |
| Fall, when the NY State Comptroller releases its balance-of-payments report | New state data | Copy the link to the report's companion Excel workbook from the press release. In GitHub, open **Actions → Update data and deploy → Run workflow** and fill in "State data" with the fiscal year and link. |
| Whenever | Descriptions | Edit `web/data/descriptions.json` and commit; the site redeploys automatically. |

The DoD site blocks automated downloads, which is why the exhibits are a manual step.

### Checks the build performs

- Spending and revenue must match Treasury's published totals to within $1 million.
- Every state's categories must add up, its balance must match the Comptroller's figure, and its numbers must match its own population. This last check caught misaligned rows in the FY 2024 workbook.
- Defense accounts are scaled to Treasury's totals. Where public account data falls well short (mainly classified activity), the remainder appears as a "Not itemized" box instead of being spread across other accounts.

## Running it on your computer

Needs Python 3.10 or newer.

```bash
pip install -r requirements.txt
python3 pipeline/update.py          # refresh all data (a few minutes, mostly USAspending)
cd web && python3 -m http.server 8000
# then open http://localhost:8000
```

The page loads its data with `fetch`, so it must be served over HTTP; opening `index.html` directly will not work.

## Hosting

The site is plain static files in `web/`, published to GitHub Pages by `.github/workflows/update-and-deploy.yml` on every push to `main` and after each data refresh. Any static host (Netlify, Cloudflare Pages) can serve the same folder.

## License

Code: MIT (see `LICENSE`). Federal data is public domain. State figures are © Office of the New York State Comptroller, used with attribution. Map shapes: us-atlas (ISC). D3 and TopoJSON: ISC. Fonts: SIL Open Font License.
