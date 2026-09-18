/** Served verbatim, so its comments ship. Kept in one file: the dashboard has no build step for assets. */
const HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>On-chain P&amp;L</title>
<style>
  :root {
    color-scheme: light;
    --plane:#f9f9f7; --surface:#fcfcfb; --line:#e1e0d9; --baseline:#c3c2b7;
    --ink:#0b0b0b; --ink-2:#52514e; --muted:#898781;
    --profit:#2a78d6; --loss:#e34948; --ring:rgba(11,11,11,.10);
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      color-scheme: dark;
      --plane:#0d0d0d; --surface:#1a1a19; --line:#2c2c2a; --baseline:#383835;
      --ink:#ffffff; --ink-2:#c3c2b7; --muted:#898781;
      --profit:#3987e5; --loss:#e66767; --ring:rgba(255,255,255,.10);
    }
  }
  :root[data-theme="dark"] {
    color-scheme: dark;
    --plane:#0d0d0d; --surface:#1a1a19; --line:#2c2c2a; --baseline:#383835;
    --ink:#ffffff; --ink-2:#c3c2b7; --muted:#898781;
    --profit:#3987e5; --loss:#e66767; --ring:rgba(255,255,255,.10);
  }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--plane); color:var(--ink);
         font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif; }
  header { padding:22px 20px 0; max-width:1180px; margin:0 auto; }
  h1 { font-size:21px; margin:0 0 2px; letter-spacing:-.01em; }
  .sub { color:var(--ink-2); font-size:13px; }
  main { padding:14px 20px 56px; max-width:1180px; margin:0 auto; display:grid; gap:14px; }
  .panel { background:var(--surface); border:1px solid var(--ring); border-radius:10px; }
  .filters { display:flex; flex-wrap:wrap; gap:10px; align-items:end; padding:12px 14px; }
  .f { display:flex; flex-direction:column; gap:3px; }
  .f label { font-size:11px; color:var(--muted); text-transform:uppercase; letter-spacing:.04em; }
  select { background:var(--plane); color:var(--ink); border:1px solid var(--ring);
           border-radius:7px; padding:6px 9px; font:inherit; font-size:13px; }
  .grow { flex:1; }
  .tiles { display:grid; grid-template-columns:repeat(auto-fit,minmax(140px,1fr)); gap:1px;
           background:var(--ring); border-radius:10px; overflow:hidden; border:1px solid var(--ring); }
  .tile { background:var(--surface); padding:13px 15px; }
  .tile .k { font-size:11px; color:var(--muted); text-transform:uppercase; letter-spacing:.04em; }
  .tile .v { font-size:21px; margin-top:3px; font-variant-numeric:tabular-nums; }
  .tile.hero .v { font-size:36px; line-height:1.1; letter-spacing:-.02em; }
  .pos { color:var(--profit); } .neg { color:var(--loss); }
  .chart { padding:14px 16px 8px; }
  .chart h2 { font-size:14px; margin:0; font-weight:600; }
  .legend { display:flex; gap:14px; align-items:center; margin:2px 0 10px; font-size:12px; color:var(--ink-2); }
  .legend i { width:10px; height:10px; border-radius:2px; display:inline-block; margin-right:5px; vertical-align:-1px; }
  .wrap { position:relative; }
  .tip { position:absolute; pointer-events:none; opacity:0; transition:opacity .08s;
         background:var(--surface); border:1px solid var(--ring); border-radius:8px;
         padding:7px 9px; font-size:12px; white-space:nowrap; box-shadow:0 6px 18px rgba(0,0,0,.18); z-index:3; }
  .tip b { font-variant-numeric:tabular-nums; }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th { text-align:left; font-size:11px; color:var(--muted); text-transform:uppercase;
       letter-spacing:.04em; padding:9px 12px; border-bottom:1px solid var(--ring); font-weight:600; }
  td { padding:8px 12px; border-bottom:1px solid var(--line); font-variant-numeric:tabular-nums; }
  tr:last-child td { border-bottom:0; }
  td.num { text-align:right; }
  a { color:var(--profit); text-decoration:none; }
  a:hover { text-decoration:underline; }
  .pill { font-size:11px; padding:1px 7px; border-radius:99px; border:1px solid var(--ring); color:var(--ink-2); }
  .scroll { overflow-x:auto; }
  .empty { padding:26px 16px; color:var(--muted); font-size:13px; text-align:center; }
  footer { max-width:1180px; margin:0 auto; padding:0 20px 30px; color:var(--muted); font-size:12px; }
</style>
</head>
<body>
<header>
  <h1>On-chain P&amp;L</h1>
  <div class="sub" id="sub">loading…</div>
</header>
<main>
  <section class="panel filters">
    <div class="f"><label for="chain">Chain</label><select id="chain"></select></div>
    <div class="f"><label for="address">Address</label><select id="address"></select></div>
    <div class="f"><label for="outcome">Outcome</label>
      <select id="outcome"><option value="all">All</option><option value="landed">Landed</option><option value="reverted">Reverted</option></select></div>
    <div class="f"><label for="hours">Window</label>
      <select id="hours"><option value="1">1 hour</option><option value="8">8 hours</option><option value="24" selected>24 hours</option><option value="72">3 days</option><option value="168">7 days</option></select></div>
    <div class="grow"></div>
    <div class="f"><label for="theme">Theme</label>
      <select id="theme"><option value="auto">Auto</option><option value="light">Light</option><option value="dark">Dark</option></select></div>
  </section>

  <section class="tiles" id="tiles"></section>

  <section class="panel chart">
    <h2>Net profit and loss over time</h2>
    <div class="legend">
      <span><i style="background:var(--profit)"></i>Profit</span>
      <span><i style="background:var(--loss)"></i>Loss</span>
      <span style="color:var(--muted)">bars are net USD per bucket; the table below carries every value</span>
    </div>
    <div class="wrap"><div id="chart"></div><div class="tip" id="tip"></div></div>
  </section>

  <section class="panel scroll">
    <table>
      <thead><tr>
        <th>Time (UTC)</th><th>Chain</th><th>From</th><th>Outcome</th>
        <th class="num">Gas</th><th class="num">Profit</th><th class="num">Net USD</th><th>Tx</th>
      </tr></thead>
      <tbody id="rows"></tbody>
    </table>
    <div class="empty" id="empty" hidden>Nothing in this window.</div>
  </section>
</main>
<footer id="foot"></footer>

<script>
var META = null, DATA = null;
function $(id) { return document.getElementById(id); }
function usd(v) {
  if (v === null || v === undefined || !isFinite(v)) return "—";
  var sign = v < 0 ? "-" : "";
  var a = Math.abs(v);
  var digits = a >= 1 ? 2 : a >= 0.01 ? 4 : 6;
  return sign + "$" + a.toFixed(digits);
}
function signed(v) { return (v > 0 ? "+" : "") + usd(v); }
function cls(v) { return v === null ? "" : v > 0 ? "pos" : v < 0 ? "neg" : ""; }
function stamp(seconds) { return new Date(seconds * 1000).toISOString().replace("T", " ").slice(0, 16); }

function setTheme(mode) {
  if (mode === "auto") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", mode);
  try { localStorage.setItem("theme", mode); } catch (e) {}
  if (DATA) draw();
}

function tiles(t) {
  var landRate = t.sent ? (100 * t.landed / t.sent).toFixed(1) + "%" : "—";
  var cards = [
    { k: "Net", v: signed(t.netUsd), c: cls(t.netUsd), hero: true },
    { k: "Gross profit", v: usd(t.grossUsd), c: "" },
    { k: "Gas", v: usd(t.gasUsd), c: "" },
    { k: "Sent", v: String(t.sent), c: "" },
    { k: "Landed", v: t.landed + " (" + landRate + ")", c: "" },
    { k: "Reverted", v: String(t.reverted), c: "" }
  ];
  if (t.unpriced) cards.push({ k: "Unpriced", v: String(t.unpriced), c: "" });
  $("tiles").innerHTML = cards.map(function (c) {
    return '<div class="tile' + (c.hero ? " hero" : "") + '"><div class="k">' + c.k +
           '</div><div class="v ' + c.c + '">' + c.v + "</div></div>";
  }).join("");
}

// A bar rounded only at its data end, so the baseline stays a hard edge.
function barPath(x, w, y0, y1, r) {
  var up = y1 < y0, h = Math.abs(y1 - y0);
  if (h < 0.4) return "M" + x + " " + y0 + "h" + w;
  var rr = Math.min(r, w / 2, h);
  return up
    ? "M" + x + " " + y0 + "V" + (y1 + rr) + "a" + rr + " " + rr + " 0 0 1 " + rr + " " + -rr +
      "h" + (w - 2 * rr) + "a" + rr + " " + rr + " 0 0 1 " + rr + " " + rr + "V" + y0 + "Z"
    : "M" + x + " " + y0 + "V" + (y1 - rr) + "a" + rr + " " + rr + " 0 0 0 " + rr + " " + rr +
      "h" + (w - 2 * rr) + "a" + rr + " " + rr + " 0 0 0 " + rr + " " + -rr + "V" + y0 + "Z";
}

function draw() {
  var el = $("chart"), tip = $("tip");
  var pts = DATA.series || [];
  if (pts.length === 0) { el.innerHTML = '<div class="empty">No transactions in this window.</div>'; return; }

  var W = 1000, H = 220, L = 58, R = 12, T = 14, B = 26;
  var iw = W - L - R, ih = H - T - B;
  var top = Math.max.apply(null, pts.map(function (p) { return Math.abs(p.netUsd); }));
  if (!(top > 0)) top = 1;
  var y0 = T + ih / 2;
  var scale = (ih / 2) / top;
  var slot = iw / pts.length;
  var w = Math.max(1, slot - 2);

  var parts = [];
  // Recessive grid: zero plus one step either side.
  [top, top / 2, 0, -top / 2, -top].forEach(function (v) {
    var y = y0 - v * scale;
    var zero = v === 0;
    parts.push('<line x1="' + L + '" y1="' + y + '" x2="' + (W - R) + '" y2="' + y +
      '" stroke="' + (zero ? "var(--baseline)" : "var(--line)") + '" stroke-width="1" />');
    parts.push('<text x="' + (L - 8) + '" y="' + (y + 4) + '" text-anchor="end" font-size="11" fill="var(--muted)">' +
      (zero ? "0" : signed(v)) + "</text>");
  });

  pts.forEach(function (p, i) {
    var x = L + i * slot + 1;
    var y1 = y0 - p.netUsd * scale;
    var colour = p.netUsd < 0 ? "var(--loss)" : "var(--profit)";
    parts.push('<path d="' + barPath(x, w, y0, y1, 4) + '" fill="' + colour + '" />');
  });

  // Time labels only at the ends and middle, so they never collide.
  [0, Math.floor(pts.length / 2), pts.length - 1].forEach(function (i, n) {
    var p = pts[i];
    if (!p) return;
    var x = L + i * slot + w / 2;
    var anchor = n === 0 ? "start" : n === 2 ? "end" : "middle";
    parts.push('<text x="' + x + '" y="' + (H - 8) + '" text-anchor="' + anchor +
      '" font-size="11" fill="var(--muted)">' + stamp(p.at).slice(5) + "</text>");
  });

  // One hit target per bucket, wider than the bar.
  pts.forEach(function (p, i) {
    var x = L + i * slot;
    parts.push('<rect x="' + x + '" y="' + T + '" width="' + slot + '" height="' + ih +
      '" fill="transparent" data-i="' + i + '" />');
  });

  el.innerHTML = '<svg viewBox="0 0 ' + W + " " + H + '" style="width:100%;height:auto;display:block" ' +
    'role="img" aria-label="Net profit and loss per time bucket">' + parts.join("") + "</svg>";

  var svg = el.querySelector("svg");
  svg.addEventListener("mousemove", function (ev) {
    var target = ev.target.getAttribute && ev.target.getAttribute("data-i");
    if (target === null) { tip.style.opacity = 0; return; }
    var p = pts[Number(target)];
    tip.innerHTML = "<div>" + stamp(p.at) + "</div><div><b class='" + cls(p.netUsd) + "'>" + signed(p.netUsd) +
      "</b> net</div><div style='color:var(--muted)'>" + p.landed + " landed of " + p.sent + " sent</div>";
    var box = el.getBoundingClientRect();
    tip.style.opacity = 1;
    tip.style.left = Math.min(box.width - tip.offsetWidth - 4, Math.max(0, ev.clientX - box.left + 12)) + "px";
    tip.style.top = Math.max(0, ev.clientY - box.top - tip.offsetHeight - 10) + "px";
  });
  svg.addEventListener("mouseleave", function () { tip.style.opacity = 0; });
}

function rows() {
  var body = $("rows"), list = DATA.trades || [];
  $("empty").hidden = list.length > 0;
  var site = {};
  (META.chains || []).forEach(function (c) { site[c.name] = c.explorerSite; });
  body.innerHTML = list.map(function (t) {
    var link = site[t.chain] ? site[t.chain] + "/tx/" + t.hash : null;
    var short = t.hash.slice(0, 10) + "…";
    return "<tr>" +
      "<td>" + stamp(t.timestamp) + "</td>" +
      "<td>" + t.chain + "</td>" +
      "<td>" + t.fromLabel + "</td>" +
      '<td><span class="pill">' + (t.status === 1 ? "landed" : "reverted") + "</span></td>" +
      '<td class="num">' + usd(t.gasUsd) + "</td>" +
      '<td class="num">' + (t.profitSymbol ? usd(t.profitUsd) + " " + t.profitSymbol : "—") + "</td>" +
      '<td class="num ' + cls(t.netUsd) + '">' + signed(t.netUsd) + "</td>" +
      "<td>" + (link ? '<a href="' + link + '" target="_blank" rel="noreferrer">' + short + "</a>" : short) + "</td>" +
      "</tr>";
  }).join("");
}

function addresses() {
  var chain = $("chain").value, select = $("address"), had = select.value;
  var list = [];
  (META.chains || []).forEach(function (c) {
    if (chain === "all" || c.name === chain) {
      c.addresses.forEach(function (a) { list.push(a); });
    }
  });
  select.innerHTML = '<option value="all">All</option>' + list.map(function (a) {
    return '<option value="' + a.address + '">' + a.label + "</option>";
  }).join("");
  if (had && select.querySelector('option[value="' + had + '"]')) select.value = had;
}

// Asking for more than the poller holds would quietly show a short window as if it were full.
function windows(held) {
  var choices = [1, 8, 24, 72, 168].filter(function (h) { return h < held; });
  choices.push(held);
  $("hours").innerHTML = choices.map(function (h) {
    var label = h < 48 ? h + (h === 1 ? " hour" : " hours") : Math.round(h / 24) + " days";
    return '<option value="' + h + '"' + (h === held ? " selected" : "") + ">" + label + "</option>";
  }).join("");
}

function query() {
  return "?chain=" + $("chain").value + "&address=" + $("address").value +
         "&outcome=" + $("outcome").value + "&hours=" + $("hours").value;
}

async function load() {
  if (!META) {
    META = await (await fetch("/api/meta")).json();
    $("chain").innerHTML = '<option value="all">All</option>' +
      (META.chains || []).map(function (c) { return '<option value="' + c.name + '">' + c.name + "</option>"; }).join("");
    addresses();
    windows(META.windowHours);
  }
  DATA = await (await fetch("/api/trades" + query())).json();
  tiles(DATA.totals);
  draw();
  rows();
  var when = DATA.refreshedAt ? new Date(DATA.refreshedAt).toISOString().slice(11, 19) + " UTC" : "never";
  $("sub").textContent = DATA.totals.sent + " transactions · refreshed " + when;
  var notes = [];
  if (DATA.truncated) notes.push(DATA.truncated + " older rows not shown");
  if (DATA.totals.unpriced) notes.push(DATA.totals.unpriced + " trades hold a token with no price, so their profit is missing from the totals");
  notes.push("bucket " + Math.round(DATA.stepSeconds / 60) + " min");
  $("foot").textContent = notes.join(" · ");
}

["chain", "address", "outcome", "hours"].forEach(function (id) {
  $(id).addEventListener("change", function () { if (id === "chain") addresses(); load(); });
});
$("theme").addEventListener("change", function () { setTheme(this.value); });
// ?theme= wins over what this browser remembered, so a link can carry the mode it was read in.
var asked = new URLSearchParams(location.search).get("theme");
try {
  var saved = asked === "dark" || asked === "light" || asked === "auto" ? asked : localStorage.getItem("theme");
  if (saved) { $("theme").value = saved; setTheme(saved); }
} catch (e) {}

load();
setInterval(load, 30000);
</script>
</body>
</html>`;

export function page(): string {
  return HTML;
}
