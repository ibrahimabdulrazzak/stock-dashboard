// Stock portfolio dashboard front end.
const $ = (s) => document.querySelector(s);
const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const num = new Intl.NumberFormat("en-US", { maximumFractionDigits: 4 });
const pct = (x) => (x >= 0 ? "+" : "−") + Math.abs(x * 100).toFixed(2) + "%";
const signed = (x) => (x >= 0 ? "+" : "−") + usd.format(Math.abs(x));
const cls = (x) => (x > 0 ? "up" : x < 0 ? "down" : "");
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

let holdings = [];
let quotes = {};
let range = "6mo";
let selected = null; // ticker shown in line chart, or null for whole portfolio
let lineChart, allocChart;

async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { "Content-Type": "application/json" }, ...opts });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || res.statusText);
  return body;
}

async function loadAll() {
  $("#updated").textContent = "Updating prices…";
  holdings = await api("/api/holdings");
  if (holdings.length) {
    quotes = await api("/api/quotes?symbols=" + holdings.map((h) => h.symbol).join(","));
  }
  render();
  drawLine();
  $("#updated").textContent = "Updated " + new Date().toLocaleTimeString();
}

function rows() {
  return holdings.map((h) => {
    const q = quotes[h.symbol] || {};
    const price = q.price ?? null;
    const value = price != null ? price * h.shares : null;
    const cost = h.cost * h.shares;
    const day = price != null && q.prevClose ? (price - q.prevClose) * h.shares : null;
    return { ...h, q, price, value, costBasis: cost, gain: value != null ? value - cost : null,
             day, dayPct: q.prevClose ? price / q.prevClose - 1 : null };
  });
}

function render() {
  const r = rows();
  const total = r.reduce((a, x) => a + (x.value || 0), 0);
  const cost = r.reduce((a, x) => a + x.costBasis, 0);
  const day = r.reduce((a, x) => a + (x.day || 0), 0);
  const gain = total - cost;
  $("#t-value").textContent = usd.format(total);
  $("#t-cost").textContent = usd.format(cost);
  setSigned("#t-gain", gain, signed(gain));
  setSigned("#t-gain-pct", gain, cost ? pct(gain / cost) : "");
  setSigned("#t-day", day, signed(day));
  const prevTotal = total - day;
  setSigned("#t-day-pct", day, prevTotal ? pct(day / prevTotal) : "");

  $("#empty").hidden = r.length > 0;
  const tb = $("#holdings tbody");
  tb.innerHTML = "";
  for (const x of r.sort((a, b) => (b.value || 0) - (a.value || 0))) {
    const tr = document.createElement("tr");
    if (x.symbol === selected) tr.className = "sel";
    const err = x.q.error ? `<span class="name down">${esc(x.q.error)}</span>` : `<span class="name">${esc(x.q.name || "")}</span>`;
    tr.innerHTML = `
      <td><span class="sym">${esc(x.symbol)}</span>${err}</td>
      <td class="num">${num.format(x.shares)}</td>
      <td class="num">${usd.format(x.cost)}</td>
      <td class="num">${x.price != null ? usd.format(x.price) : "–"}</td>
      <td class="num ${cls(x.day)}">${x.dayPct != null ? pct(x.dayPct) : "–"}</td>
      <td class="num">${x.value != null ? usd.format(x.value) : "–"}</td>
      <td class="num ${cls(x.gain)}">${x.gain != null ? signed(x.gain) + "<br><small>" + (x.costBasis ? pct(x.gain / x.costBasis) : "") + "</small>" : "–"}</td>
      <td class="num">${total && x.value ? ((x.value / total) * 100).toFixed(1) + "%" : "–"}</td>
      <td><button class="del" title="Remove ${esc(x.symbol)}" aria-label="Remove ${esc(x.symbol)}">×</button></td>`;
    tr.addEventListener("click", (e) => {
      if (e.target.closest(".del")) return;
      selected = selected === x.symbol ? null : x.symbol;
      render(); drawLine();
    });
    tr.querySelector(".del").addEventListener("click", async () => {
      if (!confirm(`Remove ${x.symbol} from your portfolio?`)) return;
      holdings = await api("/api/holdings/" + encodeURIComponent(x.symbol), { method: "DELETE" });
      if (selected === x.symbol) selected = null;
      loadAll();
    });
    tb.appendChild(tr);
  }
  drawAlloc(r, total);
}

function setSigned(sel, v, text) {
  const el = $(sel);
  el.textContent = text;
  el.className = el.className.replace(/\b(up|down)\b/g, "").trim() + " " + cls(v);
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------- charts ----------

function baseOpts(fmt) {
  const grid = css("--grid"), ink = css("--text-2");
  return {
    responsive: true, maintainAspectRatio: false, animation: false,
    interaction: { mode: "index", intersect: false },
    plugins: { legend: { display: false },
      tooltip: { callbacks: { label: (c) => " " + fmt(c.parsed.y ?? c.parsed.x) } } },
    scales: {
      x: { grid: { display: false }, ticks: { color: ink, maxTicksLimit: innerWidth < 600 ? 4 : 6, maxRotation: 0 }, border: { color: grid } },
      y: { grid: { color: grid }, ticks: { color: ink, callback: (v) => fmt(v) }, border: { display: false } },
    },
  };
}

async function drawLine() {
  const symbols = selected ? [selected] : holdings.map((h) => h.symbol);
  $("#chart-title").textContent = selected ? `${selected} price` : "Portfolio value";
  $("#chart-note").textContent = selected
    ? "Share price over time. Click the row again to go back to the whole portfolio."
    : "Value of your current shares over time. Click a row in the table to see one stock.";
  let labels = [], data = [];
  if (symbols.length) {
    const series = await Promise.all(symbols.map((s) =>
      api(`/api/history?symbol=${encodeURIComponent(s)}&range=${range}`).catch(() => [])));
    if (selected) {
      labels = series[0].map((p) => p.date);
      data = series[0].map((p) => p.close);
    } else {
      // Align every stock on the union of dates, carrying the last close forward.
      const dates = [...new Set(series.flat().map((p) => p.date))].sort();
      const maps = series.map((s) => new Map(s.map((p) => [p.date, p.close])));
      const last = symbols.map(() => null);
      for (const d of dates) {
        let sum = 0, complete = true;
        symbols.forEach((sym, i) => {
          if (maps[i].has(d)) last[i] = maps[i].get(d);
          if (last[i] == null) complete = false;
          else sum += last[i] * holdings.find((h) => h.symbol === sym).shares;
        });
        if (complete) { labels.push(d); data.push(+sum.toFixed(2)); }
      }
    }
  }
  const accent = css("--accent");
  const cfg = {
    type: "line",
    data: { labels, datasets: [{ data, borderColor: accent, borderWidth: 2, pointRadius: 0,
      pointHoverRadius: 5, pointHoverBorderWidth: 2, pointHoverBorderColor: css("--surface"),
      pointHoverBackgroundColor: accent, fill: true, backgroundColor: accent + "14", tension: 0.15 }] },
    options: baseOpts((v) => usd.format(v)),
  };
  const fmtDate = (d) => new Date(d + "T00:00:00").toLocaleDateString("en-US",
    range === "5y" || range === "1y" ? { month: "short", year: "2-digit" } : { month: "short", day: "numeric" });
  cfg.options.scales.x.ticks.callback = function (v) { return fmtDate(this.getLabelForValue(v)); };
  cfg.options.plugins.tooltip.callbacks.title = (items) => fmtDate(items[0].label);
  if (lineChart) lineChart.destroy();
  lineChart = new Chart($("#line"), cfg);
}

function drawAlloc(r, total) {
  const items = r.filter((x) => x.value).sort((a, b) => b.value - a.value);
  // Keep the chart readable: top 8 positions, the rest folded into "Other".
  const top = items.slice(0, 8);
  const rest = items.slice(8).reduce((a, x) => a + x.value, 0);
  const labels = top.map((x) => x.symbol), vals = top.map((x) => x.value / total * 100);
  if (rest) { labels.push("Other"); vals.push(rest / total * 100); }
  const opts = baseOpts((v) => v.toFixed(1) + "%");
  opts.indexAxis = "y";
  opts.interaction = { mode: "nearest", axis: "y", intersect: false };
  opts.scales.x.grid = { color: css("--grid") };
  opts.scales.x.ticks.callback = (v) => v + "%";
  opts.scales.y.grid = { display: false };
  opts.scales.y.ticks = { color: css("--text") };
  const cfg = { type: "bar", data: { labels, datasets: [{ data: vals, backgroundColor: css("--accent"),
    borderRadius: 4, borderSkipped: "start", barThickness: 16 }] }, options: opts };
  if (allocChart) allocChart.destroy();
  allocChart = new Chart($("#alloc"), cfg);
}

// ---------- events ----------

$("#add-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = new FormData(e.target), msg = $("#form-msg");
  msg.className = "msg"; msg.textContent = "Looking up " + f.get("symbol").toUpperCase() + "…";
  try {
    await api("/api/holdings", { method: "POST", body: JSON.stringify(Object.fromEntries(f)) });
    msg.textContent = "Added " + f.get("symbol").toUpperCase() + ".";
    e.target.reset();
    loadAll();
  } catch (err) {
    msg.className = "msg err"; msg.textContent = err.message;
  }
});

$("#ranges").addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b) return;
  range = b.dataset.r;
  document.querySelectorAll("#ranges button").forEach((x) => x.classList.toggle("on", x === b));
  drawLine();
});

$("#refresh").addEventListener("click", loadAll);
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { render(); drawLine(); });
setInterval(loadAll, 60_000);
loadAll().catch((e) => { $("#updated").textContent = "Error: " + e.message; });
