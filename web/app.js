/* Federal Budget Viewer
   Spending / revenue drill-downs from Treasury's Monthly Treasury Statement, and a state map from the
   NY State Comptroller's balance-of-payments data. All data is produced by the scripts in pipeline/. */
(() => {
  const $ = (id) => document.getElementById(id);
  const state = {
    view: "spending", group: "agency", fy: null, sfy: null,
    path: [], selected: null,
    measure: "balance", basis: "capita", adjust: false, stateSel: null,
    cache: {}, manifest: null, desc: {},
  };

  // ---------------------------------------------------------------- formatting
  function money(v, opts = {}) {
    const s = v < 0 ? "−" : (opts.sign && v > 0 ? "+" : "");
    const a = Math.abs(v);
    let out;
    if (opts.dollars || a < 1e5) out = Math.round(a).toLocaleString("en-US");
    else if (a >= 1e12) out = (a / 1e12).toFixed(a >= 1e13 ? 1 : 2) + "T";
    else if (a >= 1e9) out = (a / 1e9).toFixed(a >= 1e11 ? 0 : 1) + "B";
    else if (a >= 1e6) out = (a / 1e6).toFixed(a >= 1e8 ? 0 : 1) + "M";
    else out = Math.round(a / 1e3) + "K";
    return s + "$" + out;
  }
  const pct = (x) => (x >= 0.1 ? (x * 100).toFixed(0) : x >= 0.001 ? (x * 100).toFixed(1) : "<0.1") + "%";
  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const short = (n) => n.replace(/^Department of (the )?/, "");
  const fmtDate = (s) => new Date(s + "T12:00:00").toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });

  // ---------------------------------------------------------------- color
  // Ramps are read from CSS tokens so they follow the light/dark theme.
  let ramps = {};
  function readRamps() {
    const cs = getComputedStyle(document.documentElement);
    const v = (n) => cs.getPropertyValue(n).trim();
    ramps = { out: d3.interpolateLab(v("--out-0"), v("--out-1")), in: d3.interpolateLab(v("--in-0"), v("--in-1")),
      outMid: d3.interpolateLab(v("--mid"), v("--out-1")), inMid: d3.interpolateLab(v("--mid"), v("--in-1")),
      inkDark: v("--ink-dark"), inkLight: v("--ink-light") };
  }
  const flow = () => (state.view === "revenue" ? "in" : "out");
  // darker = more: t from size relative to the largest sibling
  const shade = (v, max, dir = flow()) => ramps[dir](0.06 + 0.94 * Math.sqrt(Math.max(0, v) / (max || 1)));
  function inkFor(c) {
    const { r, g, b } = d3.rgb(c);
    const L = (x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * L(r) + 0.7152 * L(g) + 0.0722 * L(b) > 0.32 ? ramps.inkDark : ramps.inkLight;
  }

  // ---------------------------------------------------------------- data
  async function getJSON(url) {
    if (state.cache[url]) return state.cache[url];
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${url}: ${r.status}`);
    return (state.cache[url] = await r.json());
  }
  async function budgetData(fy) {
    const [spending, functions, revenue] = await Promise.all(
      ["spending", "functions", "revenue"].map((n) => getJSON(`data/fy${fy}/${n}.json`)));
    return { spending, functions, revenue };
  }

  // ---------------------------------------------------------------- init
  async function init() {
    readRamps();
    try {
      state.manifest = await getJSON("data/manifest.json");
      state.desc = await getJSON("data/descriptions.json").catch(() => ({}));
    } catch (e) {
      $("map").innerHTML = `<div class="empty">Could not load the data files. Serve the web folder over HTTP; opening index.html directly will not work.</div>`;
      return;
    }
    const by = (k) => state.manifest.years.filter((y) => y[k]).map((y) => y.fy).sort((a, b) => b - a);
    state.fy = by("budget")[0];
    state.sfy = by("states")[0];
    budgetData(state.fy).then((d) => { state.budget = d; sources(); }).catch(() => {});
    if (state.sfy) getJSON(`data/states/ffy${state.sfy}.json`).then(() => sources()).catch(() => {});

    $("fy").addEventListener("change", () => {
      if (state.view === "states") state.sfy = +$("fy").value; else state.fy = +$("fy").value;
      index = null;
      state.path = []; state.selected = null; render();
    });
    $("tab-spending").onclick = () => setView("spending");
    $("tab-revenue").onclick = () => setView("revenue");
    $("tab-states").onclick = () => setView("states");
    $("g-agency").onclick = () => setGroup("agency");
    $("g-function").onclick = () => setGroup("function");
    for (const m of ["balance", "received", "paid"]) $("m-" + m).onclick = () => { state.measure = m; render(); };
    $("b-capita").onclick = () => { state.basis = "capita"; render(); };
    $("b-total").onclick = () => { state.basis = "total"; render(); };
    $("d-raw").onclick = () => { state.adjust = false; render(); };
    $("d-adj").onclick = () => { state.adjust = true; render(); };
    window.addEventListener("resize", debounce(() => { if (state.view !== "states") drawTreemap(); }, 120));
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { readRamps(); render(); });
    new MutationObserver(() => { readRamps(); render(); }).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

    initSearch();
    const h = location.hash.replace("#", "");
    setView(["spending", "revenue", "states"].includes(h) ? h : "spending");
  }
  function setView(v) {
    state.view = v; state.path = []; state.selected = null;
    for (const t of ["spending", "revenue", "states"]) $("tab-" + t).setAttribute("aria-selected", v === t);
    $("groupWrap").hidden = v !== "spending";
    $("stateOpts").hidden = v !== "states";
    try { history.replaceState(null, "", "#" + v); } catch (e) { /* not allowed in some frames */ }
    // year selector lists the years that exist for this view
    const key = v === "states" ? "states" : "budget";
    const years = state.manifest.years.filter((y) => y[key]).map((y) => y.fy).sort((a, b) => b - a);
    $("fy").innerHTML = years.map((y) => `<option value="${y}">FY ${y}</option>`).join("");
    $("fy").value = v === "states" ? state.sfy : state.fy;
    $("fyLabel").textContent = v === "states" ? "State data for" : "Fiscal year";
    render();
  }
  function setGroup(g) {
    state.group = g; state.path = []; state.selected = null;
    $("g-agency").setAttribute("aria-pressed", g === "agency");
    $("g-function").setAttribute("aria-pressed", g === "function");
    render();
  }

  async function render() {
    if (state.view === "states") return renderStates();
    let d;
    try { d = await budgetData(state.fy); }
    catch (e) { $("map").innerHTML = `<div class="empty">No data for FY ${state.fy}. Run pipeline/build_budget.py for this year.</div>`; return; }
    state.budget = d;
    const m = d.spending.meta;
    setLedger(
      ["Revenue (net receipts)", money(m.receipts), `${money(d.revenue.tree.v)} collected, ${money(-d.revenue.tree.o)} refunded`],
      ["Spending (net outlays)", money(m.outlays), `${money(d.spending.tree.v)} paid out, less offsets`],
      ["Deficit", money(m.deficit), `${pct(-m.deficit / m.outlays)} of spending was borrowed`]);
    $("asof").textContent = `Actual receipts and outlays for the fiscal year ending ${fmtDate(m.record_date)}, from the Treasury's final statement.`;
    sources();
    const doc = state.view === "revenue" ? d.revenue : state.group === "function" ? d.functions : d.spending;
    if (!state.path.length || state.path[0] !== doc.tree) { state.path = [doc.tree]; state.selected = null; }
    $("map").classList.remove("geo");
    drawCrumbs(); drawTreemap(); drawPanel();
  }
  function setLedger(a, b, c) {
    [[a, "l1", "sumR", "sumR2"], [b, "l2", "sumO", "sumO2"], [c, "l3", "sumD", "sumD2"]].forEach(([x, l, v, s]) => {
      $(l).textContent = x[0]; $(v).textContent = x[1]; $(s).textContent = x[2];
    });
  }

  // ---------------------------------------------------------------- descriptions
  function describe(scope, node, parent) {
    const d = state.desc[scope] || {};
    if (parent && d[`${parent.n} › ${node.n}`]) return d[`${parent.n} › ${node.n}`];
    if (d[node.n]) return d[node.n];
    if (/^Other\b|^All Other$/.test(node.n) && parent)
      return `Smaller items within ${parent.n} that the source reports as one combined amount.`;
    return parent ? `Part of ${parent.n}. The source gives no further detail on this line.` : "";
  }
  const scope = () => (state.view === "revenue" ? "revenue" : state.group === "function" ? "functions" : "spending");

  // ---------------------------------------------------------------- spending & revenue
  const here = () => state.path[state.path.length - 1];
  const rootNode = () => state.path[0];
  const reduceMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  let layout = new Map();   // node -> {x, y, w, h} in the current treemap layer
  function drill(node) {
    if (node.c && node.c.length) {
      const from = layout.get(node);
      state.path.push(node); state.selected = null;
      drawCrumbs(); drawTreemap(from ? { zoomIn: from } : {}); drawPanel();
    } else {
      state.selected = node;
      drawCrumbs(); markSelected(); drawPanel();
    }
  }
  function up(i) {
    if (i >= state.path.length - 1) { state.selected = null; drawCrumbs(); markSelected(); drawPanel(); return; }
    const child = state.path[i + 1];   // the box we are backing out of, as seen from level i
    state.path = state.path.slice(0, i + 1); state.selected = null;
    drawCrumbs(); drawTreemap({ zoomOutFrom: child }); drawPanel();
  }
  function markSelected() {
    document.querySelectorAll("#map .tile").forEach((t) => t.classList.toggle("sel", t._node === state.selected));
  }

  function drawCrumbs() {
    const el = $("crumbs");
    if (state.view === "states") {
      el.innerHTML = state.stateSel
        ? `<button data-i="0">All states</button><span class="sep">›</span><span class="here">${esc(state.stateSel)}</span>`
        : `<span class="here">All states</span>`;
      const b = el.querySelector("button"); if (b) b.onclick = () => { state.stateSel = null; renderStates(); };
      return;
    }
    el.innerHTML = state.path.map((n, i) => {
      const last = i === state.path.length - 1 && !state.selected;
      const label = i === 0 ? (state.view === "revenue" ? "All revenue" : "All spending") : n.n;
      return (i ? `<span class="sep">›</span>` : "") + (last ? `<span class="here">${esc(label)}</span>` : `<button data-i="${i}">${esc(label)}</button>`);
    }).join("") + (state.selected ? `<span class="sep">›</span><span class="here">${esc(state.selected.n)}</span>` : "");
    el.querySelectorAll("button").forEach((b) => (b.onclick = () => up(+b.dataset.i)));
  }

  function drawTreemap(opts = {}) {
    const el = $("map");
    const node = here();
    if (!node || state.view === "states") return;
    const kids = (node.c || []).filter((k) => k.v > 0);
    const W = el.clientWidth, H = el.clientHeight;
    const old = [...el.children];
    const layer = document.createElement("div");
    layer.className = "layer";
    const newLayout = new Map();
    if (!kids.length) {
      layer.innerHTML = `<div class="empty">No further detail is published for this item.</div>`;
    } else {
      const shallow = { n: node.n, c: kids.map((k) => ({ ...k, c: (k.c || []).filter((g) => g.v > 0).map((g) => ({ n: g.n, v: g.v })) })) };
      const h = d3.hierarchy(shallow, (d) => d.c).sum((d) => (d.c && d.c.length ? 0 : Math.max(d.v, 0)));
      d3.treemap().size([W, H]).round(true).tile(d3.treemapSquarify.ratio(1.3))(h);
      const total = rootNode().v, max = Math.max(...kids.map((k) => k.v));
      h.children.forEach((c, i) => {
        const k = kids[i], w = c.x1 - c.x0, hh = c.y1 - c.y0;
        newLayout.set(k, { x: c.x0, y: c.y0, w, h: hh });
        if (w < 1 || hh < 1) return;
        const fill = k.gap ? "var(--line)" : shade(k.v, max), ink = k.gap ? "var(--fg)" : inkFor(fill);
        const b = document.createElement("button");
        const hasKids = k.c && k.c.length;
        b._node = k;
        b.className = "tile" + (hasKids ? "" : " leaf") + (w > 220 && hh > 120 ? " lg" : "") + (k.gap ? " gap" : "") + (k === state.selected ? " sel" : "");
        Object.assign(b.style, { left: c.x0 + "px", top: c.y0 + "px", width: w + "px", height: hh + "px", background: fill, color: ink });
        b.setAttribute("aria-label", `${k.n}, ${money(k.v)}, ${pct(k.v / node.v)} of ${node.n}${hasKids ? ". Open" : ""}`);
        if (c.children) c.children.forEach((g) => {
          const sp = document.createElement("span");
          sp.className = "sub-t";
          Object.assign(sp.style, { left: g.x0 - c.x0 + "px", top: g.y0 - c.y0 + "px", width: g.x1 - g.x0 + "px", height: g.y1 - g.y0 + "px" });
          b.appendChild(sp);
        });
        if (w > 74 && hh > 30) {
          const cap = document.createElement("span");
          cap.className = "cap";
          cap.innerHTML = `<span class="nm">${esc(short(k.n))}</span>` + (hh > 46 ? `<span class="am">${money(k.v)}${isBA(k) ? " funded" : " · " + pct(k.v / node.v)}</span>` : "");
          b.appendChild(cap);
        }
        b.onclick = () => drill(k);
        b.onmousemove = (e) => tip(e, isBA(k) ? `<b>${esc(k.n)}</b>${money(k.v)} funded (enacted)` + (k.fy_prev != null ? `<br>prior year ${money(k.fy_prev || 0)} · next request ${money(k.fy_req || 0)}` : "") + (hasKids ? `<br>${k.c.length} ${k.c.length === 1 ? "item" : "items"} inside, click to open` : "")
          : `<b>${esc(k.n)}</b>${money(k.v)}<br>${pct(k.v / node.v)} of ${esc(node.n)}` + (state.path.length > 1 ? `<br>${pct(k.v / total)} of the total` : "") + (hasKids ? `<br>${k.c.length} ${k.c.length === 1 ? "item" : "items"} inside, click to open` : ""));
        b.onmouseleave = hideTip;
        layer.appendChild(b);
      });
    }
    el.appendChild(layer);
    layout = newLayout;
    hideTip();

    // zoom: the new layer grows out of the clicked box (in) or shrinks back into it (out)
    const box = opts.zoomIn || (opts.zoomOutFrom && newLayout.get(opts.zoomOutFrom));
    if (!box || reduceMotion() || !old.length || box.w < 1 || box.h < 1) { old.forEach((o) => o.remove()); return; }
    const toBox = (b) => `translate(${b.x}px, ${b.y}px) scale(${b.w / W}, ${b.h / H})`;
    const fromBox = (b) => `translate(${-b.x * W / b.w}px, ${-b.y * H / b.h}px) scale(${W / b.w}, ${H / b.h})`;
    const zin = !!opts.zoomIn;
    const anim = { duration: 520, easing: "cubic-bezier(.3,.7,.2,1)", fill: "forwards" };
    layer.animate([{ transform: zin ? toBox(box) : fromBox(box), opacity: zin ? 0.4 : 0 }, { transform: "none", opacity: 1 }], anim);
    old.forEach((o) => {
      o.style.pointerEvents = "none";
      const a = o.animate([{ transform: "none", opacity: 1 }, { transform: zin ? fromBox(box) : toBox(box), opacity: 0 }], anim);
      a.onfinish = () => o.remove();
    });
  }

  const MONTHS = ["October", "November", "December", "January", "February", "March", "April", "May", "June", "July", "August", "September"];
  const isBA = (n) => n && n.basis === "ba";

  function drawPanel() {
    const p = $("panel");
    const node = state.selected || here();
    const parent = state.selected ? here() : state.path[state.path.length - 2];
    const isRoot = node === rootNode();
    const total = rootNode().v;
    const rev = state.view === "revenue";
    const kids = (state.selected ? [] : node.c) || [];
    const max = kids.length ? Math.max(...kids.map((k) => k.v), 1) : 1;
    const fy = state.fy;
    const kidsBA = kids.length && isBA(kids[0]);
    const cols = state.budget.spending.meta.dod_exhibits?.columns || { prev: `FY ${fy - 1} actual`, mid: `FY ${fy} enacted`, req: `FY ${fy + 1} request` };

    const title = isRoot ? (rev ? "All federal revenue" : state.group === "function" ? "Spending by purpose" : "All federal spending") : node.n;
    const rootDesc = rev ? `Everything the federal government collected in FY ${fy}, by source. Box sizes show gross collections before refunds.`
      : state.group === "function" ? `FY ${fy} spending grouped by purpose (budget function), regardless of which agency paid it. Treasury does not publish this view any deeper.`
      : `Everything the federal government paid out in FY ${fy}, grouped by the agency that paid it. Click a box to see what is inside.`;
    const label = isRoot ? (rev ? "Total collected" : "Total paid out") : rev ? "Revenue source"
      : isBA(node) ? (node.grp ? `Group · ${cols.mid} funding` : node.project ? `Construction project · ${cols.mid} funding` : `Program · ${cols.mid} funding`) : "Spending item";
    let html = `<div><span class="label">${label}</span><h2>${esc(title)}</h2></div>`;

    if (isBA(node) && node.grp) {
      html += `<div class="headline"><span class="big num out">${money(node.fy_mid)}</span>
        <span class="small">${cols.mid} · ${node.c.length} items</span></div>
        <p class="desc">${esc(describe("spending", node, parent) .replace(/^Part of .*$/, `Items within ${parent ? parent.n : "this activity"}, grouped by ${node.c.some((x) => x.project) ? "state or country" : "activity group"}.`))}</p>` +
        (node.fy_prev || node.fy_req ? yearBars(node, cols) : "");
    } else if (isBA(node)) {
      // a budget-exhibit line item: show funding over three years, not outlays
      const share = parent && parent.c ? node.v / parent.c.reduce((a, x) => a + x.v, 0) : 0;
      html += `<div class="headline"><span class="big num out">${money(node.fy_mid)}</span>
        <span class="small">${cols.mid}${share ? ` · ${pct(share)} of ${esc(parent.n)} line items` : ""}</span></div>
        <p class="desc">${esc(describe("spending", node, parent))}</p>` + (node.project && !node.fy_prev && !node.fy_req ? "" : yearBars(node, cols));
      if (node.qty) html += `<p class="small">${node.qty.toLocaleString("en-US")} units funded in ${cols.mid.replace(" enacted", "")}.</p>`;
      if (node.ng || node.rsv) html += `<p class="small">Includes ${[node.ng ? money(node.ng) + " for the National Guard" : "", node.rsv ? money(node.rsv) + " for the Reserves" : ""].filter(Boolean).join(" and ")}.</p>`;
      if (node.project) html += `<p class="small">Construction projects are usually funded once, so prior-year and request amounts appear only when a project is funded in phases.</p>`;
      if (node.fy_mid_disc != null && node.fy_mid - node.fy_mid_disc > 0.5e6)
        html += `<p class="small">Of the ${cols.mid.replace(" enacted", "")} amount, ${money(node.fy_mid_disc)} is regular appropriations and ${money(node.fy_mid - node.fy_mid_disc)} comes from the 2025 reconciliation law (P.L. 119-21).</p>`;
      html += `<div class="basis">This is funding Congress approved, not money spent this year. Aircraft and missiles are paid for over several years as they are built, so a year's spending mostly pays for programs funded in earlier years.</div>`;
      html += `<p class="small">${node.project ? "Project number" : /^\d{7}/.test(node.pe || "") ? "Program element" : "Line item"} ${esc(node.pe || "")}</p>`;
    } else {
      html += `<div class="headline"><span class="big num ${rev ? "in" : "out"}">${money(node.v)}</span>
        ${!isRoot ? `<span class="small">${pct(node.v / total)} of all ${rev ? "revenue" : "spending"}${parent && parent !== rootNode() ? ` · ${pct(node.v / parent.v)} of ${esc(parent.n)}` : ""}</span>` : ""}</div>
        <p class="desc">${esc(isRoot ? rootDesc : describe(scope(), node, parent))}</p>`;
    }
    if (node.detail && node.detail.exhibit_only) {
      html += `<p class="small">Working capital funds buy goods and services and sell them to military units, so their gross outlays are many times their net cost. The items below are the funds' ${cols.mid.replace(" enacted", "")} appropriations from the RF-1 exhibit instead.</p>`;
    } else if (node.detail) {
      const mo = MONTHS[(node.detail.period || 12) - 1];
      html += `<p class="small">Split across accounts and budget activities using USAspending.gov outlays reported through ${mo}, excluding work paid back by other customers, then scaled to Treasury's full-year total (×${node.detail.scale.toFixed(3)}).${node.detail.gap ? ` ${money(node.detail.gap)} of Treasury's total is not itemized by account in the public data and is shown as a separate box.` : ""}</p>`;
    }
    if (node.from && node.from.length) html += fromBlock(node);
    if (kidsBA && !isBA(node)) {
      const sumBA = kids.reduce((a, k) => a + k.v, 0);
      html += `<div class="basis"><b>Below this level the numbers change basis.</b> This budget activity paid out ${money(node.v)} in FY ${fy}. The programs below are sized by the ${money(sumBA)} Congress approved for them in ${cols.mid.replace(" enacted", "")}, which will be spent over several years.</div>`;
    }

    if (kids.length) {
      html += `<div class="rows" role="list">` + kids.map((k, i) => {
        const fill = shade(k.v, max);
        const ba = isBA(k);
        const sub = ba ? `<span class="more" style="color:var(--muted)">${cols.prev.replace(" actual", "")} ${money(k.fy_prev || 0)} · ${cols.req.replace(" request", "")} req. ${money(k.fy_req || 0)}</span>` : (k.c && k.c.length ? `<span class="more">${k.c.length} ${k.c.length === 1 ? "item" : "items"} ›</span>` : "");
        return `<button class="row" role="listitem" data-i="${i}">
          <span class="rn"><span class="sw" style="background:${fill}"></span>${esc(k.n)}</span>
          <span class="rv">${k.v ? money(k.v) : "—"} <span class="small">${k.v ? pct(k.v / (ba ? kids.reduce((a, x) => a + x.v, 0) : node.v)) : ""}</span></span>
          <span class="bar"><i style="width:${Math.max(0.5, (k.v / max) * 100)}%;background:${shade(max, max)}"></i></span>${sub}</button>`;
      }).join("") + `</div>`;
    } else if (!isBA(node)) {
      html += `<p class="small">${node.basis === "outlay" ? "The budget exhibits do not break this out further." : "This is the most detailed line Treasury publishes for this item."}</p>`;
    }
    if (!isBA(node)) html += reconcile(node, isRoot, rev);
    if (node.off && node.off.length) html += listBlock(rev ? "Refunds and adjustments" : "Offsetting receipts at this level", node.off);
    if (node.xf && node.xf.length) html += listBlock("Intragovernmental transfers at this level", node.xf);
    html += sourceLinks(node, kidsBA);
    p.innerHTML = html;
    p.querySelectorAll(".row[data-i]").forEach((b) => (b.onclick = () => drill(kids[+b.dataset.i])));
  }
  function yearBars(n, cols) {
    const vals = [[cols.prev, n.fy_prev || 0], [cols.mid, n.fy_mid || 0], [cols.req, n.fy_req || 0]];
    const m = Math.max(...vals.map((v) => v[1]), 1);
    return `<div class="cmp">` + vals.map(([l, v], i) => `<div class="line"><span>${l}</span><span class="track"><i style="width:${(v / m) * 100}%;background:${ramps.out(i === 1 ? 0.85 : 0.45)}"></i></span><span class="num">${v ? money(v) : "—"}</span></div>`).join("") + `</div>`;
  }
  function fromBlock(n) {
    const tot = n.from.reduce((a, x) => a + x.v, 0), m = Math.max(...n.from.map((x) => x.v));
    const cur = n.from.find((x) => x.y === state.fy);
    return `<div><h3>Which year's money was spent</h3><p class="desc small" style="margin:2px 0 6px">Procurement and R&amp;D money stays available for 3 to 5 years. ${cur ? `Only ${pct(cur.v / tot)} of this year's spending came from FY ${state.fy} appropriations.` : ""}</p><div class="cmp">` +
      n.from.slice(0, 7).map((x) => `<div class="line"><span>${x.y ? "FY " + x.y : "No-year"}</span><span class="track"><i style="width:${(x.v / m) * 100}%;background:${ramps.out(x.y === state.fy ? 0.85 : 0.45)}"></i></span><span class="num">${pct(x.v / tot)}</span></div>`).join("") + `</div></div>`;
  }
  function sourceLinks(node, kidsBA) {
    const L = state.budget.spending.meta.links || {};
    const rev = state.view === "revenue";
    if (node.code || node.basis === "outlay" || node.detail || kidsBA || isBA(node)) {
      const acct = state.path.concat(state.selected ? [state.selected] : []).map((n) => n.code).filter(Boolean).pop();
      return `<div class="srcs"><span>Source data:</span>` +
        (acct ? `<a href="https://www.usaspending.gov/federal_account/${acct}" target="_blank" rel="noopener">USAspending: account ${acct}</a>` : `<a href="https://www.usaspending.gov/federal_account" target="_blank" rel="noopener">USAspending federal accounts</a>`) +
        `<a href="${L.dod_p1 || "https://comptroller.war.gov/"}" target="_blank" rel="noopener">DoD procurement exhibit (P-1)</a><a href="${L.dod_r1 || "https://comptroller.war.gov/"}" target="_blank" rel="noopener">DoD RDT&amp;E exhibit (R-1)</a>` +
        `<a href="${L.spending}" target="_blank" rel="noopener">Treasury Table 5</a></div>`;
    }
    const tbl = rev ? ["revenue", "Table 4, receipts by source"] : state.group === "function" ? ["functions", "Table 9, outlays by function"] : ["spending", "Table 5, outlays by agency"];
    return `<div class="srcs"><span>Source data:</span><a href="${L.dataset}" target="_blank" rel="noopener">Monthly Treasury Statement</a>
      <a href="${L[tbl[0]]}" target="_blank" rel="noopener">${tbl[1]} (raw data)</a></div>`;
  }
  function reconcile(node, isRoot, rev) {
    const o = node.o || 0, t = node.t || 0;
    if (!o && !t && !isRoot) return "";
    const line = (k, v, cls = "") => `<div class="${cls}"><span>${k}</span><span class="v">${money(v, { sign: cls !== "tot" && v !== node.v })}</span></div>`;
    let h = `<div class="recon"><span class="label">How this nets to the official figure</span>`;
    h += line(rev ? "Gross collections (box size)" : "Paid out to the public (box size)", node.v);
    if (o) h += line(rev ? "Refunds and adjustments" : "Offsetting receipts", o);
    if (t) h += line("Intragovernmental transfers, net", t);
    h += line(rev ? "Net receipts" : "Net outlays", node.net, "tot");
    if (isRoot && !rev && state.group === "agency" && t)
      h += `<p class="small" style="margin:6px 0 0">The transfer line is mostly agencies' retirement contributions as employers, already counted in their payroll, net of interest the Treasury pays its own trust funds.</p>`;
    return h + `</div>`;
  }
  function listBlock(title, items) {
    const sum = items.reduce((a, e) => a + e.v, 0);
    return `<details class="offs"><summary>${title} (${money(sum)})</summary><div class="rows">` +
      items.map((e) => `<div class="row static"><span class="rn">${esc(e.n)}</span><span class="rv">${money(e.v)}</span></div>`).join("") + `</div></details>`;
  }

  // ---------------------------------------------------------------- states
  let geo = null;
  async function renderStates() {
    let d;
    try {
      d = await getJSON(`data/states/ffy${state.sfy}.json`);
      if (!geo) {
        const topo = await getJSON("data/geo/states-albers-10m.json");
        geo = topojson.feature(topo, topo.objects.states).features;
      }
    } catch (e) { $("map").innerHTML = `<div class="empty">No state data for FY ${state.sfy}. Run pipeline/build_states.py.</div>`; return; }
    state.sdata = d;
    for (const m of ["balance", "received", "paid"]) $("m-" + m).setAttribute("aria-pressed", state.measure === m);
    $("b-capita").setAttribute("aria-pressed", state.basis === "capita");
    $("b-total").setAttribute("aria-pressed", state.basis === "total");
    $("d-raw").setAttribute("aria-pressed", !state.adjust);
    $("d-adj").setAttribute("aria-pressed", state.adjust);
    const disableAdj = state.measure === "paid";
    $("d-raw").disabled = $("d-adj").disabled = disableAdj;

    const n = d.national, k = adjFactor();
    setLedger(
      ["Taxes paid by the states", money(n.paid.v), `${money(n.paid.v / n.pop, { dollars: true })} per person`],
      ["Spending received by the states", money(n.received.v * k), state.adjust ? `deficit-adjusted (actual ${money(n.received.v)})` : `${money(n.received.v / n.pop, { dollars: true })} per person`],
      ["Gap", money(n.received.v * k - n.paid.v, { sign: true }), state.adjust ? "zero by construction" : "spending allocated to states minus taxes"]);
    $("asof").textContent = `Federal taxes paid and spending received, state by state, for federal fiscal year ${d.meta.ffy} (the latest available).`;
    sources();
    $("map").classList.add("geo");
    drawCrumbs(); drawUSMap(); drawStatePanel();
  }
  const adjFactor = () => (state.adjust ? state.sdata.national.paid.v / state.sdata.national.received.v : 1);
  function metric(s) {
    const k = adjFactor();
    const raw = state.measure === "paid" ? s.paid.v : state.measure === "received" ? s.received.v * k : s.received.v * k - s.paid.v;
    return state.basis === "capita" ? raw / s.pop : raw;
  }
  function colorScale() {
    const S = state.sdata.states;
    const vals = Object.entries(S).filter(([n]) => n !== "District of Columbia").map(([, s]) => metric(s));
    if (state.measure === "balance") {
      const m = d3.max(vals, Math.abs) || 1;
      const f = (v) => { const t = Math.min(1, Math.abs(v) / m) ** 0.85; return v >= 0 ? ramps.outMid(t) : ramps.inMid(t); };
      f.ticks = [[-m, "Pays more"], [0, "Even"], [m, "Receives more"]];
      f.gradient = `linear-gradient(90deg, ${ramps.inMid(1)}, ${ramps.inMid(.5)}, ${ramps.outMid(0)}, ${ramps.outMid(.5)}, ${ramps.outMid(1)})`;
      return f;
    }
    const [lo, hi] = d3.extent(vals), dir = state.measure === "paid" ? "in" : "out";
    const f = (v) => ramps[dir](Math.max(0, Math.min(1, (v - lo) / (hi - lo || 1))));
    f.ticks = [[lo, ""], [(lo + hi) / 2, ""], [hi, ""]];
    f.gradient = `linear-gradient(90deg, ${ramps[dir](0)}, ${ramps[dir](.5)}, ${ramps[dir](1)})`;
    return f;
  }
  const fmtMetric = (v, sign) => money(v, { sign, dollars: state.basis === "capita" });

  function drawUSMap() {
    const el = $("map"), S = state.sdata.states, color = colorScale();
    const path = d3.geoPath();
    const sel = state.stateSel;
    let svg = `<svg class="us" viewBox="0 0 975 610" role="img" aria-label="Map of the United States">`;
    for (const f of geo) {
      const nm = f.properties.name, s = S[nm];
      if (!s) continue;
      svg += `<path class="st${nm === sel ? " sel" : ""}" data-n="${esc(nm)}" d="${path(f)}" fill="${color(metric(s))}"><title>${esc(nm)}</title></path>`;
    }
    // D.C. is too small to click, so give it a marker
    const dc = geo.find((f) => f.properties.name === "District of Columbia");
    if (dc && S["District of Columbia"]) {
      const [x, y] = path.centroid(dc);
      svg += `<circle class="dc" data-n="District of Columbia" cx="${x + 14}" cy="${y + 8}" r="6" fill="${color(metric(S["District of Columbia"]))}"></circle>`;
    }
    svg += `</svg>`;
    const sign = state.measure === "balance";
    const tk = color.ticks.map(([v, l]) => `<span>${fmtMetric(v, sign)}${l ? " · " + l : ""}</span>`).join("");
    const what = state.measure === "balance" ? "Spending received minus taxes paid" : state.measure === "received" ? "Federal spending received" : "Federal taxes paid";
    el.innerHTML = svg + `<div class="legend"><span>${what}, ${state.basis === "capita" ? "per person" : "total"}${state.adjust && state.measure !== "paid" ? ", deficit-adjusted" : ""}. D.C. is shown as a dot and left out of the color range.</span>
      <div class="ramp" style="background:${color.gradient}"></div><div class="ticks">${tk}</div></div>`;
    el.querySelectorAll("[data-n]").forEach((p) => {
      const nm = p.dataset.n;
      p.onclick = () => { state.stateSel = nm; drawCrumbs(); drawUSMap(); drawStatePanel(); };
      p.onmousemove = (e) => tip(e, `<b>${esc(nm)}</b>${what}: ${fmtMetric(metric(S[nm]), sign)}${state.basis === "capita" ? " per person" : ""}`);
      p.onmouseleave = hideTip;
    });
  }

  function drawStatePanel() {
    const p = $("panel"), S = state.sdata.states, nm = state.stateSel, k = adjFactor();
    const sign = state.measure === "balance";
    const L = state.sdata.meta.links;
    const src = `<div class="srcs"><span>Source data:</span><a href="${L.report}" target="_blank" rel="noopener">Comptroller's report (PDF)</a><a href="${L.data}" target="_blank" rel="noopener">State data (Excel)</a></div>`;
    if (!nm) {
      const color = colorScale();
      const list = Object.entries(S).filter(([n]) => n !== "District of Columbia").map(([n, s]) => [n, metric(s)]).sort((a, b) => b[1] - a[1]);
      const max = d3.max(list, (x) => Math.abs(x[1]));
      const lead = { balance: "States ranked by how much more they receive than they pay. The bottom of the list pays the most more than it receives.",
        received: "States ranked by federal spending received.", paid: "States ranked by federal taxes paid." }[state.measure];
      p.innerHTML = `<div><span class="label">All states · FY ${state.sdata.meta.ffy}</span><h2>Click a state for its breakdown</h2></div>
        <p class="desc">${lead}${state.measure !== "paid" && !state.adjust ? " Because the government borrows to cover the deficit, most states receive more than they pay. Switch to deficit-adjusted to compare on a balanced basis." : ""}</p>
        <div class="rows" role="list">${list.map(([n, v], i) => `<button class="row" role="listitem" data-n="${esc(n)}">
          <span class="rn"><span class="small" style="width:1.6em;text-align:right">${i + 1}</span><span class="sw" style="background:${color(v)}"></span>${esc(n)}</span>
          <span class="rv">${fmtMetric(v, sign)}</span></button>`).join("")}</div>` + src;
      p.querySelectorAll(".row[data-n]").forEach((b) => (b.onclick = () => { state.stateSel = b.dataset.n; drawCrumbs(); drawUSMap(); drawStatePanel(); }));
      return;
    }
    const s = S[nm];
    const rec = s.received.v * k, paid = s.paid.v, bal = rec - paid;
    const per = (v) => money(v / s.pop, { dollars: true });
    const ranks = (fn) => Object.entries(S).filter(([n]) => n !== "District of Columbia").map(([n, x]) => [n, fn(x)]).sort((a, b) => b[1] - a[1]).findIndex(([n]) => n === nm) + 1;
    const balRank = ranks((x) => (x.received.v * k - x.paid.v) / x.pop);
    const verdict = bal >= 0 ? `received ${money(bal)} more than it paid` : `paid ${money(-bal)} more than it received`;
    const maxBar = Math.max(rec, paid);
    let html = `<div><span class="label">State · FY ${state.sdata.meta.ffy}${state.adjust ? " · deficit-adjusted" : ""}</span><h2>${esc(nm)}</h2></div>
      <div class="headline"><span class="big num ${bal >= 0 ? "out" : "in"}">${money(bal / s.pop, { sign: true, dollars: true })}</span>
      <span class="small">per person${nm !== "District of Columbia" ? ` · ranks ${balRank} of 50 (1 = receives most)` : ""}</span></div>
      <p class="desc">${esc(nm)} ${verdict} in federal fiscal year ${state.sdata.meta.ffy}${state.adjust ? ", after scaling spending to remove the deficit" : ""}. Population ${s.pop.toLocaleString("en-US")}.</p>
      <div class="cmp">
        <div class="line"><span>Received</span><span class="track"><i style="width:${(rec / maxBar) * 100}%;background:${ramps.out(.75)}"></i></span><span class="num">${money(rec)} · ${per(rec)}</span></div>
        <div class="line"><span>Paid</span><span class="track"><i style="width:${(paid / maxBar) * 100}%;background:${ramps.in(.75)}"></i></span><span class="num">${money(paid)} · ${per(paid)}</span></div>
      </div>`;
    html += catBlock("Where its federal spending comes from", s.received, "out", k, s.pop, state.sdata.national.received, state.sdata.national.pop);
    html += catBlock("Federal taxes it pays", s.paid, "in", 1, s.pop, state.sdata.national.paid, state.sdata.national.pop);
    if (state.adjust) html += `<p class="small">Deficit-adjusted amounts scale every spending line by ${(k * 100).toFixed(1)}%, the share of state-allocated spending covered by taxes nationally.</p>`;
    if (state.sdata.meta.omitted) html += `<p class="small">${esc(state.sdata.meta.omitted)}</p>`;
    html += src;
    p.innerHTML = html;
  }
  function catBlock(title, tree, dir, k, pop, nat, natPop) {
    const cats = tree.c, max = cats[0].v * k;
    const natMap = Object.fromEntries(nat.c.map((c) => [c.n, c]));
    const vsNat = (v, natNode) => { if (!natNode) return ""; const r = (v / pop) / (natNode.v * (dir === "out" ? k : 1) / natPop); return `${r >= 1 ? "+" : "−"}${Math.abs((r - 1) * 100).toFixed(0)}% vs. national per person`; };
    let h = `<div><h3>${title}</h3><p class="desc small" style="margin-top:2px">${esc(describe("states", tree))}</p></div><div>`;
    for (const c of cats) {
      const v = c.v * k, fill = shade(v, max, dir);
      const head = `<span class="rn"><span class="sw" style="background:${fill}"></span>${esc(c.n)}</span><span class="rv">${money(v)} <span class="small">${money(v / pop, { dollars: true })}/person</span></span>`;
      const note = `<p class="desc small" style="margin:2px 0 4px 20px">${esc(describe("states", c))} <span class="small">${vsNat(v, natMap[c.n])}.</span></p>`;
      if (c.c && c.c.length) {
        const natKids = Object.fromEntries((natMap[c.n]?.c || []).map((x) => [x.n, x]));
        const m2 = c.c[0].v * k;
        h += `<details class="cat"><summary>${head}</summary>${note}<div class="rows">` + c.c.map((g) => {
          const gv = g.v * k;
          return `<div class="row static" title="${esc(describe("states", g))}"><span class="rn"><span class="sw" style="background:${shade(gv, m2, dir)}"></span>${esc(g.n)}</span>
            <span class="rv">${money(gv)} <span class="small">${vsNat(gv, natKids[g.n])}</span></span></div>`;
        }).join("") + `</div></details>`;
      } else {
        h += `<details class="cat"><summary>${head}</summary>${note}</details>`;
      }
    }
    return h + `</div>`;
  }

  // ---------------------------------------------------------------- search
  const squash = (t) => String(t || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  let index = null, indexKey = "", hits = [], hitPos = -1;
  async function buildIndex() {
    const key = `${state.fy}`;
    if (index && indexKey === key) return index;
    const d = state.budget || await budgetData(state.fy);
    index = [];
    const walk = (n, trail, view) => {
      for (const c of n.c || []) {
        const path = trail.concat([c]);
        index.push({ n: c.n, q: squash(c.n) + " " + squash(c.pe), path, view, node: c });
        walk(c, path, view);
      }
    };
    walk(d.spending.tree, [d.spending.tree], "spending");
    walk(d.revenue.tree, [d.revenue.tree], "revenue");
    try {
      const sd = await getJSON(`data/states/ffy${state.sfy}.json`);
      for (const nm of Object.keys(sd.states)) index.push({ n: nm, q: squash(nm), view: "states", state: nm });
    } catch (e) { /* state data optional */ }
    indexKey = key;
    return index;
  }
  async function runSearch() {
    const raw = $("q").value.trim();
    const box = $("results");
    if (raw.length < 2) { box.hidden = true; hits = []; return; }
    const idx = await buildIndex();
    const toks = raw.split(/\s+/).map(squash).filter(Boolean);
    const whole = squash(raw);
    hits = idx.filter((e) => toks.every((t) => e.q.includes(t)))
      .map((e) => ({ e, s: squash(e.n) === whole ? 0 : squash(e.n).startsWith(whole) ? 1 : 2 }))
      .sort((a, b) => a.s - b.s || (b.e.node?.v || 0) - (a.e.node?.v || 0)).slice(0, 30).map((x) => x.e);
    hitPos = -1;
    box.innerHTML = hits.length ? hits.map((e, i) => {
      const where = e.view === "states" ? "State" : e.path.slice(1, -1).map((n) => short(n.n)).slice(-3).join(" › ") || (e.view === "revenue" ? "Revenue" : "Spending");
      const amt = e.node ? (isBA(e.node) ? `${money(e.node.v)} funded` : money(e.node.v)) : "";
      return `<button class="hit" role="option" data-i="${i}"><span class="hn">${esc(e.n)}</span><span class="hw">${esc(where)}</span><span class="ha">${amt}</span></button>`;
    }).join("") : `<div class="nohit">Nothing matches “${esc(raw)}”.</div>`;
    box.hidden = false;
    box.querySelectorAll(".hit").forEach((b) => (b.onclick = () => go(hits[+b.dataset.i])));
  }
  function go(e) {
    $("results").hidden = true;
    $("q").blur();
    if (e.view === "states") {
      if (state.view !== "states") setView("states");
      state.stateSel = e.state; renderStates();
      return;
    }
    if (state.view !== e.view) setView(e.view);
    if (e.view === "spending" && state.group !== "agency") setGroup("agency");
    const node = e.node, trail = e.path;
    const hasKids = node.c && node.c.length;
    state.path = hasKids ? trail.slice() : trail.slice(0, -1);
    state.selected = hasKids ? null : node;
    drawCrumbs(); drawTreemap(); drawPanel();
    $("crumbs").scrollIntoView({ block: "nearest", behavior: reduceMotion() ? "auto" : "smooth" });
  }
  function initSearch() {
    const q = $("q"), box = $("results");
    q.addEventListener("input", debounce(runSearch, 120));
    q.addEventListener("focus", () => { buildIndex(); if (hits.length) box.hidden = false; });
    q.addEventListener("keydown", (ev) => {
      const items = [...box.querySelectorAll(".hit")];
      if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
        ev.preventDefault();
        hitPos = Math.max(0, Math.min(items.length - 1, hitPos + (ev.key === "ArrowDown" ? 1 : -1)));
        items.forEach((b, i) => b.classList.toggle("on", i === hitPos));
        items[hitPos]?.scrollIntoView({ block: "nearest" });
      } else if (ev.key === "Enter" && hits.length) {
        ev.preventDefault(); go(hits[Math.max(0, hitPos)]);
      } else if (ev.key === "Escape") { box.hidden = true; q.blur(); }
    });
    document.addEventListener("click", (ev) => { if (!ev.target.closest(".search")) box.hidden = true; });
  }

  // ---------------------------------------------------------------- sources & misc
  function sources() {
    const items = [];
    const b = state.budget?.spending?.meta || state.cache[`data/fy${state.fy}/spending.json`]?.meta;
    if (b && b.links) items.push(
      `<li>Spending and revenue: U.S. Treasury, <a href="${b.links.dataset}" target="_blank" rel="noopener">Monthly Treasury Statement</a> (final FY ${b.fy} statement). Raw data: <a href="${b.links.spending}" target="_blank" rel="noopener">outlays by agency</a>, <a href="${b.links.functions}" target="_blank" rel="noopener">outlays by function</a>, <a href="${b.links.revenue}" target="_blank" rel="noopener">receipts by source</a>. Built ${esc(b.generated)}.</li>`);
    const s = state.sdata?.meta || state.cache[`data/states/ffy${state.sfy}.json`]?.meta;
    const sl = s ? s.links : { report: "https://www.osc.ny.gov/files/reports/pdf/balance-of-payments-ffy-2024.pdf", data: "https://www.osc.ny.gov/files/reports/excel/fedbudgetfy2024data.xlsx" };
    items.push(`<li>States: Office of the New York State Comptroller, <a href="${sl.report}" target="_blank" rel="noopener">New York's Balance of Payments in the Federal Budget</a>, with its <a href="${sl.data}" target="_blank" rel="noopener">state-by-state data workbook</a>.</li>`);
    $("srcList").innerHTML = items.join("");
    // what each part of the data covers, and when it was built
    const up = [];
    const fmt = (iso) => iso ? new Date(iso + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "";
    if (b) up.push(`<li>Spending and revenue: Treasury's final statement for FY ${b.fy} (built ${fmt(b.generated)}).</li>`);
    if (b && b.dod_outlays) {
      const per = b.dod_outlays.period, mo = MONTHS[(per || 12) - 1], cy = per <= 3 ? b.dod_outlays.fy - 1 : b.dod_outlays.fy;
      up.push(`<li>Defense account detail: USAspending.gov outlays through ${mo} ${cy}${b.dod_exhibits ? `; program lines from the FY ${b.dod_exhibits.request_year} budget exhibits` : ""} (built ${fmt(b.dod_outlays.built)}).</li>`);
    }
    if (s) up.push(`<li>States: Comptroller's analysis of federal fiscal year ${s.ffy} (built ${fmt(s.generated)}).</li>`);
    $("updated").innerHTML = up.join("") || "<li>Unavailable.</li>";
  }
  function tip(e, html) {
    const t = $("tip");
    t.innerHTML = html; t.hidden = false;
    t.style.left = Math.min(e.clientX + 14, window.innerWidth - t.offsetWidth - 8) + "px";
    t.style.top = Math.min(e.clientY + 14, window.innerHeight - t.offsetHeight - 8) + "px";
  }
  const hideTip = () => ($("tip").hidden = true);
  function debounce(f, ms) { let t; return () => { clearTimeout(t); t = setTimeout(f, ms); }; }
  init();
})();
