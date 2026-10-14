const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const ls = { get: k => { try { return localStorage.getItem(k); } catch (e) { return null; } },
             set: (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* storage blocked: fine */ } } };
let cat, mode = ls.get('mode') === 'fgt' ? 'fgt' : 'fmg', active = null, seq = 0;
const GOOD = /^(up|connected|established|alive|enable|enabled|ok|in sync|synchronized|true|running|valid)$/i;
const BAD = /^(down|disconnected|failed|disable|disabled|idle|out of sync|error|false|expired|unknown)$/i;

// refresh=true makes the server skip its cache and query the device live
async function callM(url, refresh = false) {
  const r = await fetch(refresh ? url + (url.includes('?') ? '&' : '?') + 'refresh=true' : url, { headers: { 'X-Requested-With': 'dashboard' } });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401) { location.href = '/login'; throw new Error('Signed out'); }
  if (!r.ok) throw new Error(j.detail || r.statusText);
  return { data: j, cache: r.headers.get('X-Cache'), at: +r.headers.get('X-Cached-At') || 0 };
}
const call = async (url, refresh) => (await callM(url, refresh)).data;
const age = at => { const s = Math.max(0, Math.round(Date.now() / 1000 - at)); return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`; };
const urlFor = (c, adom, device) => mode === 'fmg'
  ? `/api/fmg/${c}?adom=${encodeURIComponent(adom || 'root')}` + (device ? `&device=${encodeURIComponent(device)}` : '')
  : `/api/fgt/${encodeURIComponent($('dev').value)}/${c}` + ($('vdom').value ? '?vdom=' + encodeURIComponent($('vdom').value) : '');

// ---- formatting -----------------------------------------------------------
function cell(v) {
  if (v === null || v === undefined || v === '') return '<span class="nul">–</span>';
  if (typeof v === 'boolean') return `<span class="${v ? 'good' : 'no'}">${v}</span>`;
  if (typeof v === 'string' || typeof v === 'number') {
    const s = String(v);
    return GOOD.test(s) ? `<span class="good">${esc(s)}</span>` : BAD.test(s) ? `<span class="no">${esc(s)}</span>` : esc(s);
  }
  if (Array.isArray(v) && v.every(x => x === null || typeof x !== 'object')) return esc(v.join(', ')) || '<span class="nul">–</span>';
  const j = JSON.stringify(v);
  return `<code title="${esc(j)}">${esc(j.length > 90 ? j.slice(0, 90) + '…' : j)}</code>`;
}
function table(rows, opt = {}) {  // opt.only = exact columns, opt.first = columns to put first, opt.hide = columns to drop
  let cols = [];
  rows.slice(0, 300).forEach(r => Object.keys(r).forEach(k => cols.includes(k) || cols.push(k)));
  if (opt.first) cols = [...opt.first.filter(c => cols.includes(c)), ...cols.filter(c => !opt.first.includes(c))];
  if (opt.only) cols = opt.only.filter(c => cols.includes(c));
  cols = cols.filter(c => c !== 'q_origin_key' && !(opt.hide || []).includes(c));
  const used = cols.filter(c => rows.some(r => r[c] !== null && r[c] !== undefined && r[c] !== ''));
  const head = used.map(c => `<th>${esc(c)}</th>`).join('');
  const body = rows.slice(0, 500).map(r =>
    `<tr data-s="${esc(JSON.stringify(r).toLowerCase())}">${used.map(c => `<td>${cellK(c, r[c])}</td>`).join('')}</tr>`).join('');
  return `<div class="scroll"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>` +
    (rows.length > 500 ? `<div class="note">Showing 500 of ${rows.length} rows – use JSON tab / Download for all.</div>` : '');
}
function kv(o) {
  const body = Object.entries(o).map(([k, v]) => `<tr data-s="${esc((k + JSON.stringify(v)).toLowerCase())}"><td class="k">${esc(k)}</td><td>${cellK(k, v)}</td></tr>`).join('');
  return `<div class="scroll"><table><tbody>${body}</tbody></table></div>`;
}
// Unwrap FortiOS envelope {results, http_status, vdom, version, serial,...} and FMG data
function unwrap(d) {
  const meta = [];
  if (d && typeof d === 'object' && !Array.isArray(d) && 'results' in d) {
    ['version', 'serial', 'vdom', 'build'].forEach(k => d[k] != null && meta.push(`${k}: ${d[k]}`));
    d = d.results;
  }
  return [d, meta];
}
// ---- resource dashboard: gauges + history charts for monitor/system/resource/usage ----
const WIN = ['1-min', '10-min', '30-min', '1-hour', '12-hour', '24-hour'];
const WLBL = { '1-min': '1 minute', '10-min': '10 minutes', '30-min': '30 minutes', '1-hour': '1 hour', '12-hour': '12 hours', '24-hour': '24 hours' };
const setWin = (r, w) => {  // buttons and dropdown stay in sync
  r.dataset.w = w; r.querySelectorAll('[data-rw]').forEach(x => x.classList.toggle('on', x.dataset.rw === w));
  const sl = r.querySelector('[data-rwsel]'); if (sl) sl.value = w;
};
const RES = { cpu: ['CPU', '%', 'used'], mem: ['Memory', '%', 'used'], disk: ['Disk', '%', 'used'], session: ['Sessions IPv4', '', 'now'], session6: ['Sessions IPv6', '', 'now'],
  setuprate: ['New sessions/s IPv4', '', 'now'], setuprate6: ['New sessions/s IPv6', '', 'now'], npu_session: ['NPU sessions', '', 'now'], disk_lograte: ['Disk log rate', '', 'now'] };
const isRes = d => d && typeof d === 'object' && !Array.isArray(d) && 'cpu' in d &&
  Object.values(d).every(v => Array.isArray(v) && v[0] && typeof v[0] === 'object' && 'current' in v[0]);
const fmtT = (ms, long) => new Date(ms).toLocaleString([], long ? { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' } : { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const nice = k => k.replace(/_/g, ' ').replace(/^./, m => m.toUpperCase());
function ring(v, lv) {
  const c = 2 * Math.PI * 30, d = Math.min(100, Math.max(0, v)) / 100 * c;
  return `<svg class="ring ${lv}" viewBox="0 0 80 80"><circle class="bg" cx="40" cy="40" r="30"/><circle class="fg" cx="40" cy="40" r="30" stroke-dasharray="${d.toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 40 40)"/><text x="40" y="46" text-anchor="middle">${v}%</text></svg>`;
}
function spark(w, pct, lv) {
  const pts = (w.values || []).slice().sort((a, b) => a[0] - b[0]);
  if (pts.length < 2) return '<div class="nul" style="height:64px">no history</div>';
  const top = pct ? 100 : Math.max(1, w.max || 0, ...pts.map(p => p[1])) * 1.15;
  const X = i => i / (pts.length - 1) * 200, Y = v => 54 - Math.min(v, top) / top * 50;
  const line = pts.map((p, i) => `${X(i).toFixed(1)},${Y(p[1]).toFixed(1)}`).join(' ');
  return `<svg class="spark ${lv}" viewBox="0 0 200 56" preserveAspectRatio="none"><polyline class="ar" points="0,56 ${line} 200,56"/>` +
    (pct ? `<line class="th" x1="0" x2="200" y1="${Y(80).toFixed(1)}" y2="${Y(80).toFixed(1)}"/>` : '') + `<polyline class="ln" points="${line}"/></svg>`;
}
function resTile(key, e) {
  const [label, unit, cap] = RES[key] || [nice(key), '', 'now'], pct = unit === '%', cur = e.current;
  const lv = pct ? (cur >= 90 ? 'bad' : cur >= 70 ? 'warn' : 'ok') : 'ac';
  const panes = WIN.filter(k => e.historical && e.historical[k]).map(k => {
    const w = e.historical[k], long = /hour/.test(k);
    return `<div class="pane" data-w="${k}">${spark(w, pct, lv)}<div class="axis"><span>${fmtT(w.start, long)}</span><span>${fmtT(w.end, long)}</span></div>` +
      `<div class="mm"><span>min <b>${w.min}${unit}</b></span><span>avg <b>${w.average}${unit}</b></span><span>max <b>${w.max}${unit}</b></span></div></div>`;
  }).join('');
  return `<div class="rt ${lv}"><div class="rh">${esc(label)}</div><div class="rv">${pct ? ring(cur, lv) : `<b>${esc(cur)}</b>`}<span class="cap">${cap}</span></div>${panes}</div>`;
}
function resView(d) {
  const main = ['cpu', 'mem', 'disk', 'session', 'session6', 'setuprate', 'setuprate6'].filter(k => d[k]);
  const rest = Object.keys(d).filter(k => !main.includes(k));
  const busy = k => d[k][0].current > 0 || Object.values(d[k][0].historical || {}).some(w => w.max > 0);
  const wins = WIN.filter(w => d.cpu[0].historical && d.cpu[0].historical[w]), sel = wins.includes('1-hour') ? '1-hour' : wins[0];
  const idle = rest.filter(k => !busy(k));
  return `<div class="res" data-w="${sel}"><div class="rbar"><span>History window</span><span class="tabs">${wins.map(w => `<button class="${w === sel ? 'on' : ''}" data-rw="${w}">${w}</button>`).join(' ')}</span>` +
    `<select class="filter" data-rwsel title="History window" style="width:auto">${wins.map(w => `<option value="${w}"${w === sel ? ' selected' : ''}>Last ${WLBL[w]}</option>`).join('')}</select></div>` +
    `<div class="rgrid">${[...main, ...rest.filter(busy)].map(k => resTile(k, d[k][0])).join('')}</div>` +
    (idle.length ? `<div class="note">Idle (always 0): ${idle.map(k => esc(nice(k))).join(', ')}</div>` : '') + '</div>';
}
// ---- end resource dashboard ----
function view(d, meta, check) {
  if (isRes(d)) return resView(d);
  const custom = viewFor(d, meta, check);
  if (custom) return custom;
  if (Array.isArray(d) && d.length && d.every(x => x && typeof x === 'object' && !Array.isArray(x))) return table(d);
  if (d && typeof d === 'object' && !Array.isArray(d)) {
    const vals = Object.values(d);
    // one-level map of objects (e.g. {"port1": {...}}) -> table with the key as first column
    if (vals.length > 1 && vals.every(x => x && typeof x === 'object' && !Array.isArray(x)))
      return table(Object.entries(d).map(([k, v]) => ({ name: k, ...v })));
    return Object.keys(d).length ? kv(d) : '<div class="msg">Empty result.</div>';
  }
  if (Array.isArray(d) && !d.length) return '<div class="msg">Empty result (nothing to show).</div>';
  return `<pre>${esc(JSON.stringify(d, null, 2))}</pre>`;
}

// ---- cards ----------------------------------------------------------------
const store = {}, reqs = {};
function card(name, desc, state, url, check) {
  const id = 'c' + (++seq);
  let head = `<header><h3>${esc(name)}</h3><span class="badge">${esc(desc)}</span><span class="grow"></span>`, body;
  if (url) reqs[id] = { name, desc, url, check };
  const rf = url ? `<button class="tool" data-rf="${id}" title="Fetch live from the device, bypassing the cache">↻ Refresh</button>` : '';
  if (state.error) {
    head += `<span class="badge bad">failed · ${state.ms} ms</span>${rf}</header>`;
    body = `<div class="msg err">${esc(state.error)}</div>`;
  } else {
    const [d, meta] = unwrap(state.data);
    store[id] = state.data;
    const n = Array.isArray(d) ? ` · ${d.length} rows` : '';
    head += meta.map(m => `<span class="badge">${esc(m)}</span>`).join('') +
      `<span class="badge ok">ok · ${state.ms} ms${n}</span>` +
      (state.cache === 'HIT' ? `<span class="badge" title="Served from the server cache">cached ${age(state.at)} ago</span>` : '') + rf +
      `<input class="filter" placeholder="filter…" data-f="${id}">` +
      `<span class="tabs"><button class="on" data-t="${id}:t">Table</button> <button data-t="${id}:j">JSON</button></span>` +
      `<button class="tool" data-c="${id}">Copy</button><button class="tool" data-d="${id}:${esc(name)}">Download</button></header>`;
    body = `<div data-p="${id}:t">${view(d, meta, check)}</div><div data-p="${id}:j" hidden><div class="scroll"><pre>${esc(JSON.stringify(state.data, null, 2))}</pre></div></div>`;
  }
  return `<div class="card" id="${id}">${head}<div class="body">${body}</div></div>`;
}
let adoms = [];
async function fetchCard(url, title, desc, refresh, check) {
  const t = performance.now();
  try { var st = await callM(url, refresh); } catch (e) { st = { error: e.message }; }
  st.ms = Math.round(performance.now() - t);
  return card(title, desc, st, url, check);
}
function runSingle(c, adom, device, refresh) {
  const title = mode === 'fgt' ? `${$('dev').value} · ${c}` : device ? `${device} · ${c}` : adom ? `${c} · ${adom}` : c;
  return fetchCard(urlFor(c, adom, device), title, cat[mode][c], refresh, c);
}
// checks usable right now: device-only checks need a device picked
const available = () => Object.entries(cat[mode]).filter(([k]) => mode !== 'fmg' || $('fdev').value || !cat.fmg_device_scoped.includes(k));
async function runOne(c, refresh) {
  if (mode !== 'fmg' || !cat.fmg_adom_scoped.includes(c)) return runSingle(c, undefined, undefined, refresh);
  const dv = $('fdev').value;
  if (dv) { const [a, n] = dv.split('|'); return runSingle(c, a, n, refresh); }
  const sel = $('adom').value;
  if (sel !== '*') return runSingle(c, sel, undefined, refresh);
  if (!adoms.length) await loadAdoms();
  return (await Promise.all(adoms.map(a => runSingle(c, a, undefined, refresh)))).join('');
}
async function loadAdoms() {
  try {
    const d = await call('/api/fmg/adoms');
    adoms = d.map(a => a.name).filter(Boolean).sort();
  } catch (e) {
    adoms = ['root'];
    if (mode === 'fmg') $('status').innerHTML = `<span class="err">Could not fetch ADOMs (${esc(e.message)}); using root.</span>`;
  }
  $('adom').innerHTML = '<option value="*">All ADOMs</option>' + adoms.map(a => `<option>${esc(a)}</option>`).join('');
  const sa = ls.get('adom'); if (sa && (sa === '*' || adoms.includes(sa))) $('adom').value = sa;
  updateCli();
}
async function loadDevices() {
  let err = null;
  const res = await Promise.all(adoms.map(a => call(`/api/fmg/inventory?adom=${encodeURIComponent(a)}`)
    .then(d => (Array.isArray(d) ? d : [d]).filter(Boolean).map(x => ({ adom: a, name: x.name, ip: x.ip, ver: x.os_ver ? `${x.os_ver}.${x.mr ?? 0}.${x.patch ?? 0}` : '', up: x.conn_status === 1 || x.conn_status === 'up', conn: x.conn_status })), e => { err = err || e.message; return []; })));
  invFmg = res.flat().filter(x => x.name);
  $('fdev').innerHTML = '<option value="">All devices</option>' + invFmg
    .map(x => `<option value="${esc(x.adom)}|${esc(x.name)}">${esc(x.name)} (${esc(x.adom)})</option>`).join('');
  if (!invFmg.length && err) $('status').innerHTML = `<span class="err">Inventory could not be loaded: ${esc(err)}</span>`;
  paintInv();
}
// ---- inventory sidebar (both tabs) ----
let invFmg = [], hl = null;  // hl = /api/health result
function paintInv() {
  const q = $('iq').value.toLowerCase();
  let items;
  if (mode === 'fmg') {
    const f = cat.fmg_server;
    items = [{ v: '', t: 'All devices', s: `${invFmg.length} managed${f ? ` by ${f.name} (${f.host})` : ' — no FortiManager in devices.json'}`, cls: '' }, ...invFmg.map(x => ({
      v: `${x.adom}|${x.name}`, t: x.name, s: [x.ip, x.ver, x.adom].filter(Boolean).join(' · '),
      cls: x.conn == null ? '' : x.up ? 'up' : 'down' }))];
  } else {
    items = cat.devices.map(n => { const h = hl?.fgt[n]; return { v: n, t: n, s: cat.device_hosts[n], cls: h ? (h.ok ? 'up' : 'down') : '', e: h?.error }; });
  }
  const sel = mode === 'fmg' ? $('fdev').value : $('dev').value;
  $('invn').textContent = mode === 'fmg' ? invFmg.length : cat.devices.length;
  const head = mode === 'fmg' && cat.fmg_server
    ? `<div class="dev" style="cursor:default;border-color:var(--bd);margin-bottom:6px"><span class="dot ${hl ? (hl.fmg.ok ? 'up' : 'down') : ''}" title="${esc(hl?.fmg.error || '')}"></span><b>${esc(cat.fmg_server.name)}</b><small>FortiManager · ${esc(cat.fmg_server.host)}${cat.fmg_configured ? '' : ' · token not set'}</small></div>` : '';
  $('invlist').innerHTML = head + items.filter(i => (i.t + i.s).toLowerCase().includes(q)).map(i =>
    `<button class="dev ${i.v === sel ? 'on' : ''}" data-dev="${esc(i.v)}" title="${esc(i.e || '')}"><span class="dot ${i.cls}"></span>${esc(i.t)}<small>${esc(i.s || '')}</small></button>`).join('')
    || '<div class="msg">No devices.</div>';
}
function pickDevice(v) {
  const s = mode === 'fmg' ? $('fdev') : $('dev');
  if (mode === 'fgt') ls.set('fgt_dev', v);
  s.value = v; s.onchange && s.onchange(); paintInv();
  const ok = active && available().some(([k]) => k === active);
  runCheck(ok ? active : mode === 'fgt' ? 'system_status' : v ? 'device_detail' : 'inventory');
}
$('iq').oninput = paintInv;
async function runCheck(c, refresh) {
  active = c; paintChips();
  $('out').innerHTML = '<div class="msg">Running…</div>';
  $('out').innerHTML = await runOne(c, refresh);
}
const runAll = async refresh => {
  $('out').innerHTML = `<div class="msg">${refresh ? 'Refreshing all checks live…' : 'Running all checks…'}</div>`;
  $('out').innerHTML = (await Promise.all(available().map(([k]) => runOne(k, refresh)))).join('');
};
$('all').onclick = () => runAll(false);
$('allLive').onclick = () => runAll(true);

// ---- snapshot: run every available check, download one JSON ----
function save(name, obj) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' }));
  a.download = name.replace(/[^\w.-]+/g, '_') + '.json'; a.click();
}
const collect = async (btn, label) => {
  const dv = $('fdev').value, sel = $('adom').value, orig = btn.innerHTML;
  document.querySelectorAll('#collectPre,#collectPost').forEach(x => x.disabled = true); btn.textContent = 'Collecting…';
  if (mode === 'fmg' && !dv && sel === '*' && !adoms.length) await loadAdoms();
  // snapshots are always live (refresh=true)
  const get = async (c, a, d) => { try { return { data: await call(urlFor(c, a, d), true) }; } catch (e) { return { error: e.message }; } };
  const checks = {};
  await Promise.all(available().map(async ([c]) => {
    if (mode !== 'fmg' || !cat.fmg_adom_scoped.includes(c)) checks[c] = await get(c);
    else if (dv) checks[c] = await get(c, ...dv.split('|'));
    else if (sel !== '*') checks[c] = await get(c, sel);
    else checks[c] = Object.fromEntries(await Promise.all(adoms.map(async a => [a, await get(c, a)])));
  }));
  const target = mode === 'fgt' ? $('dev').value : dv ? dv.split('|')[1] : sel === '*' ? 'all-adoms' : sel;
  const vdom = $('vdom').value;
  const snap = { source: mode === 'fmg' ? 'fortimanager' : 'fortigate', target, ...(mode === 'fgt' && vdom ? { vdom } : {}),
    collected_at: new Date().toISOString(), label, checks };
  const flat = Object.values(checks).flatMap(v => 'data' in v || 'error' in v ? [v] : Object.values(v));
  const failed = flat.filter(v => v.error).length;
  save(`${snap.source}_${target}_${snap.collected_at.replace(/[:.]/g, '-')}`, snap);
  let stored = 'saved on the server';
  try {
    const r = await fetch('/api/snapshots', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'dashboard' }, body: J({ label: snap.label, snapshot: snap }) });
    if (!r.ok) throw new Error(r.statusText);
  } catch (e) { stored = `<span class="err">NOT saved on the server (${esc(e.message)})</span>`; }
  $('out').innerHTML = `<div class="msg">Collected ${flat.length - failed} of ${flat.length} results from <b>${esc(target)}</b>${snap.label ? ` (label <b>${esc(snap.label)}</b>)` : ''}${failed ? ` — <span class="err">${failed} failed (errors are inside the file)</span>` : ''}. File downloaded and ${stored}.</div>`;
  document.querySelectorAll('#collectPre,#collectPost').forEach(x => x.disabled = false); btn.innerHTML = orig;
};
$('collectPre').onclick = () => collect($('collectPre'), 'pre');
$('collectPost').onclick = () => collect($('collectPost'), 'post');

// ---- compare two snapshots: diff + pass/warn/fail verdicts (all client-side) ----
const VOLATILE = /(uptime|_time$|^time|timestamp|bytes|packets|^rx_|^tx_|cpu|mem|session|^age$|last_|rate|lifetime|expire|historical|^revision$)/i;
const ID_KEYS = ['name', 'ifname', 'interface', 'id', 'oid', 'ip', 'neighbor_ip', 'sn', 'serial', 'vdom', 'tunnel', 'ip_mask'];
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
const J = JSON.stringify;
// index an array of objects by the first field that is present and unique; else match whole objects
function indexBy(arr) {
  for (const k of ID_KEYS) {
    if (!arr.every(o => o[k] != null && typeof o[k] !== 'object')) continue;
    const ks = arr.map(o => String(o[k]));
    if (new Set(ks).size === ks.length) return Object.fromEntries(arr.map(o => [String(o[k]), o]));
  }
  return Object.fromEntries(arr.map(o => [J(o), o]));
}
function diff(a, b, path, out, skip) {
  if (isObj(a) && isObj(b)) {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (skip && VOLATILE.test(k)) continue;
      const p = path ? `${path}.${k}` : k;
      if (!(k in a)) out.push({ path: p, type: 'added', after: b[k] });
      else if (!(k in b)) out.push({ path: p, type: 'removed', before: a[k] });
      else diff(a[k], b[k], p, out, skip);
    }
  } else if (Array.isArray(a) && Array.isArray(b)) {
    if (a.every(isObj) && b.every(isObj)) {
      const ia = indexBy(a), ib = indexBy(b);
      for (const k of new Set([...Object.keys(ia), ...Object.keys(ib)])) {
        const p = `${path}[${k.length > 60 ? k.slice(0, 60) + '…' : k}]`;
        if (!(k in ia)) out.push({ path: p, type: 'added', after: ib[k] });
        else if (!(k in ib)) out.push({ path: p, type: 'removed', before: ia[k] });
        else diff(ia[k], ib[k], p, out, skip);
      }
    } else if (J(a) !== J(b)) {
      const sa = new Set(a.map(J)), sb = new Set(b.map(J));
      b.filter(x => !sa.has(J(x))).forEach(x => out.push({ path, type: 'added', after: x }));
      a.filter(x => !sb.has(J(x))).forEach(x => out.push({ path, type: 'removed', before: x }));
    }
  } else if (J(a) !== J(b)) out.push({ path, type: 'changed', before: a, after: b });
}

// --- verdict rules ---
const RANK = { fail: 3, warn: 2, info: 1, pass: 0 };
const unwrapData = d => (isObj(d) && 'results' in d) ? d.results : d;
const asArr = x => Array.isArray(x) ? x : isObj(x) ? Object.values(x) : [];
// one check from a snapshot -> {data, raw} | {error} | {missing}; FMG ADOM-keyed checks are merged
function chk(snap, name) {
  const c = snap.checks?.[name];
  if (!c) return { missing: true };
  if ('data' in c) return { data: unwrapData(c.data), raw: c.data };
  if ('error' in c) return { error: c.error };
  const parts = Object.values(c), errs = parts.filter(p => p.error);
  const data = parts.filter(p => 'data' in p).flatMap(p => asArr(unwrapData(p.data)));
  return data.length || !errs.length ? { data, raw: data } : { error: errs[0].error };
}
const up = v => v === 1 || /^up$/i.test(v);
const insync = v => v === 1 || /^insync$/i.test(v);
const modified = v => v === 2 || /^modified$/i.test(v);
const pct = (a, b) => a ? (a - b) / a * 100 : 0;
const RULES = [
  { title: 'System status', check: 'system_status', fn: (a, b, ra, rb) => {
    if (ra?.serial !== rb?.serial) return { bad: [{ level: 'fail', msg: `serial changed ${ra?.serial} → ${rb?.serial}` }] };
    return ra?.version !== rb?.version
      ? { bad: [{ level: 'info', msg: `version ${ra?.version} → ${rb?.version} (build ${ra?.build} → ${rb?.build})` }] }
      : { ok: `version unchanged (${rb?.version})` };
  } },
  { title: 'HA members equal', check: 'ha_peers', fn: (a, b) => {
    const id = x => x.serial_no || x.serial || x.hostname || J(x), A = new Set(asArr(a).map(id)), B = new Set(asArr(b).map(id));
    if (!A.size && !B.size) return { na: 'no HA peers (standalone)' };
    const bad = [...A].filter(x => !B.has(x)).map(x => ({ level: 'fail', scope: x, msg: 'HA member missing after change' }))
      .concat([...B].filter(x => !A.has(x)).map(x => ({ level: 'warn', scope: x, msg: 'new HA member' })));
    return { bad, ok: `${B.size} HA member(s) unchanged` };
  } },
  { title: 'BGP peers up', check: 'bgp', fn: (a, b) => {
    const est = x => /established/i.test(x?.state || ''), B = new Map(asArr(b).map(x => [x.neighbor_ip, x]));
    const was = asArr(a).filter(est);
    if (!was.length) return { na: 'no established BGP peers before' };
    const bad = was.filter(x => !est(B.get(x.neighbor_ip))).map(x => ({ level: 'fail', scope: x.neighbor_ip, msg: `was Established, now ${B.get(x.neighbor_ip)?.state ?? 'missing'}` }));
    return { bad, ok: `${was.length} BGP peer(s) still Established` };
  } },
  { title: 'IPsec tunnels up', check: 'ipsec', fn: (a, b) => {
    const isUp = t => (t.proxyid || []).some(p => /^up$/i.test(p.status)) || /^up$/i.test(t.status || '');
    const B = new Map(asArr(b).map(t => [t.name, t])), was = asArr(a).filter(isUp);
    if (!was.length) return { na: 'no tunnels up before' };
    const bad = was.filter(t => !B.has(t.name) || !isUp(B.get(t.name))).map(t => ({ level: 'fail', scope: t.name, msg: B.has(t.name) ? 'tunnel was up, now down' : 'tunnel missing' }));
    return { bad, ok: `${was.length} tunnel(s) still up` };
  } },
  { title: 'Interfaces', check: 'interfaces', fn: (a, b) => {
    const A = new Map(asArr(a).map(x => [x.name, x])), B = new Map(asArr(b).map(x => [x.name, x])), bad = [];
    for (const [n, x] of A) if (x.link && !B.get(n)?.link) bad.push({ level: 'fail', scope: n, msg: B.has(n) ? 'link was up, now down' : 'interface missing' });
    for (const [n, x] of B) if (!x.link && !A.has(n)) bad.push({ level: 'warn', scope: n, msg: 'new interface, link down' });
    return { bad, ok: `${B.size} interfaces, no new down links` };
  } },
  { title: 'Routing table', check: 'routes', fn: (a, b) => {
    const A = asArr(a), B = asArr(b), d = pct(A.length, B.length), bad = [];
    if (d >= 5) bad.push({ level: 'fail', msg: `route count dropped ${d.toFixed(1)}% (${A.length} → ${B.length})` });
    else if (d >= 2) bad.push({ level: 'warn', msg: `route count dropped ${d.toFixed(1)}% (${A.length} → ${B.length})` });
    const dflt = r => r.some(x => x.ip_mask === '0.0.0.0/0');
    if (dflt(A) && !dflt(B)) bad.push({ level: 'fail', msg: 'default route 0.0.0.0/0 missing after change' });
    return { bad, ok: `routes ${A.length} → ${B.length}, default route ${dflt(B) ? 'present' : 'n/a'}` };
  } },
  { title: 'Resources', check: 'resources', fn: (a, b, ra, rb) => {
    const cur = (r, k) => r?.results?.[k]?.[0]?.current, bad = [];
    if (cur(rb, 'cpu') > 80) bad.push({ level: 'warn', msg: `CPU ${cur(rb, 'cpu')}% (> 80%)` });
    if (cur(rb, 'mem') > 85) bad.push({ level: 'warn', msg: `memory ${cur(rb, 'mem')}% (> 85%)` });
    const sa = cur(ra, 'session'), sb = cur(rb, 'session');
    if (sa > 0 && sb < sa * 0.7) bad.push({ level: 'warn', scope: 'sessions', msg: `sessions ${sa} → ${sb} (< 70% of before)` });
    return { bad, ok: `cpu ${cur(rb, 'cpu')}%, mem ${cur(rb, 'mem')}%, sessions ${sa} → ${sb}` };
  } },
  { title: 'FortiManager device state', check: 'inventory', fn: (a, b) => {
    const key = x => x.sn || x.name, A = new Map(asArr(a).map(x => [key(x), x])), bad = [];
    const ver = x => x ? `${parseInt(x.os_ver)}.${x.mr}.${x.patch}` : '';
    let n = 0;
    for (const x of asArr(b)) {
      n++; const s = x.name || key(x), o = A.get(key(x));
      if (o && up(o.conn_status) && !up(x.conn_status)) bad.push({ level: 'fail', scope: s, msg: 'FMG connection was up, now down' });
      if (!insync(x.conf_status)) bad.push({ level: o && insync(o.conf_status) ? 'fail' : 'warn', scope: s, msg: `FMG config status: ${x.conf_status}` });
      if (modified(x.db_status)) bad.push({ level: 'warn', scope: s, msg: 'FMG device DB modified' });
      if (o && ver(o) !== ver(x)) bad.push({ level: 'info', scope: s, msg: `FMG version ${ver(o)} → ${ver(x)}` });
    }
    return { bad, ok: `${n} FMG device(s) connected and in sync` };
  } },
];
function verdicts(A, B) {
  const out = [];
  for (const r of RULES) {
    const a = chk(A, r.check), b = chk(B, r.check), add = (level, scope, msg) => out.push({ rule: r.title, level, scope: scope || '', msg });
    if (a.missing && b.missing) continue;
    if (a.missing || b.missing) { add('info', '', `skipped: check not in the ${a.missing ? 'before' : 'after'} snapshot`); continue; }
    if (a.error) { add('info', '', `skipped: failed in the before snapshot (${a.error})`); continue; }
    if (b.error) { add('fail', '', `check failed in the after snapshot: ${b.error}`); continue; }
    const res = r.fn(a.data, b.data, a.raw, b.raw);
    if (res.na) add('info', '', res.na);
    else if (!res.bad?.length) add('pass', '', res.ok);
    else res.bad.forEach(f => add(f.level, f.scope, f.msg));
  }
  return out.sort((x, y) => RANK[y.level] - RANK[x.level]);
}
const worst = fs => fs.some(f => f.level === 'fail') ? 'fail' : fs.some(f => f.level === 'warn') ? 'warn' : 'pass';  // info never changes the verdict

// --- exports ---
const csvCell = v => { const s = v === undefined ? '' : typeof v === 'object' ? J(v) : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const toCsv = ch => ['path,change,before,after', ...ch.map(x => [x.path, x.type, x.before, x.after].map(csvCell).join(','))].join('\n');
function reportHtml(r) {
  const td = v => `<td>${esc(v === undefined ? '' : typeof v === 'object' ? J(v) : v)}</td>`;
  const name = s => `${s.source}/${s.target} @ ${s.collected_at}${s.label ? ' [' + s.label + ']' : ''}`;
  return `<!doctype html><meta charset="utf-8"><title>Snapshot comparison</title>
<style>body{font:14px system-ui;margin:24px}table{border-collapse:collapse;width:100%;margin:10px 0 24px}td,th{border:1px solid #ccc;padding:5px 8px;text-align:left;vertical-align:top;word-break:break-word}th{background:#eee}.fail{color:#c62828;font-weight:700}.warn{color:#b26a00;font-weight:700}.pass{color:#1a7f37;font-weight:700}.info{color:#667}</style>
<h1>Snapshot comparison: <span class="${r.verdict}">${r.verdict.toUpperCase()}</span></h1>
<p><b>Before:</b> ${esc(name(r.A))}<br><b>After:</b> ${esc(name(r.B))}</p>
<h2>Findings</h2><table><tr><th>Rule</th><th>Scope</th><th>Level</th><th>Message</th></tr>
${r.findings.map(f => `<tr><td>${esc(f.rule)}</td><td>${esc(f.scope)}</td><td class="${f.level}">${f.level}</td><td>${esc(f.msg)}</td></tr>`).join('')}</table>
<h2>Changes (${r.changes.length})</h2><table><tr><th>Path</th><th>Change</th><th>Before</th><th>After</th></tr>
${r.changes.map(x => `<tr>${td(x.path)}${td(x.type)}${td(x.before)}${td(x.after)}</tr>`).join('')}</table>`;
}
const saveText = (name, text, type) => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; a.click();
};

// --- compare UI: pick saved snapshots (or upload files), then compare ---
let lastCmp = null;
$('compare').onclick = async () => {
  active = null; paintChips();
  let saved = [];
  try { saved = await call('/api/snapshots'); } catch (e) { /* server list unavailable: uploads still work */ }
  const opts = '<option value="">— pick a saved snapshot —</option>' + saved.map(s =>
    `<option value="${esc(s.id)}">${esc(s.label)} · ${esc(s.source)}/${esc(s.target)} · ${esc(s.time.replace(/^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)Z$/, '$1-$2-$3 $4:$5:$6'))} · expires in ${s.expires_in_h}h</option>`).join('');
  const side = (id, t) => `<label>${t}<br><select id="s${id}" style="min-width:320px">${opts}</select></label> <label>or file <input type="file" id="f${id}" accept=".json"></label><br><br>`;
  $('out').innerHTML = `<div class="card" id="cmp"><header><h3>Compare snapshots</h3><span class="badge">${saved.length} saved on server</span></header>
    <div class="msg">${side('a', 'Before (e.g. pre)')}${side('b', 'After (e.g. post)')}
      <label><input type="checkbox" id="ig" checked> Ignore volatile fields (uptime, counters, CPU/memory, sessions, timestamps)</label><br><br>
      <button class="tool" id="go">Compare</button></div><div id="cres"></div></div>`;
  const newest = l => (saved.find(x => x.label === l) || {}).id || '';  // list is newest first
  $('sa').value = newest('pre'); $('sb').value = newest('post');
  const load = async id => {
    const f = $('f' + id).files[0], s = $('s' + id).value;
    return f ? JSON.parse(await f.text()) : s ? await call('/api/snapshots/' + encodeURIComponent(s)) : null;
  };
  $('go').onclick = async () => {
    const res = $('cres'); let A, B;
    try { [A, B] = await Promise.all([load('a'), load('b')]); } catch (e) { res.innerHTML = `<div class="msg err">Could not load snapshot: ${esc(e.message)}</div>`; return; }
    if (!A || !B) { res.innerHTML = '<div class="msg err">Select (or upload) both snapshots.</div>'; return; }
    if (!A.checks || !B.checks) { res.innerHTML = '<div class="msg err">Not a snapshot file (no "checks").</div>'; return; }
    const changes = []; diff(A.checks, B.checks, '', changes, $('ig').checked);
    const findings = verdicts(A, B), verdict = worst(findings);
    lastCmp = { A, B, changes, findings, verdict };
    const n = t => changes.filter(x => x.type === t).length, cnt = l => findings.filter(f => f.level === l).length;
    const warn = A.source !== B.source || A.target !== B.target ? `<div class="msg err">Warning: snapshots are from different targets (${esc(A.source)}/${esc(A.target)} vs ${esc(B.source)}/${esc(B.target)}).</div>` : '';
    const lvCls = { fail: 'no', warn: '', pass: 'good', info: 'nul' };
    const frows = findings.map(f => `<tr><td>${esc(f.rule)}</td><td>${esc(f.scope)}</td><td><span class="${lvCls[f.level]}" ${f.level === 'warn' ? 'style="color:var(--warn);font-weight:600"' : ''}>${f.level}</span></td><td>${esc(f.msg)}</td></tr>`).join('');
    const crows = changes.slice(0, 1000).map(x => `<tr data-s="${esc((x.path + x.type + J(x.before ?? '') + J(x.after ?? '')).toLowerCase())}">
      <td>${esc(x.path)}</td><td><span class="${x.type === 'added' ? 'good' : x.type === 'removed' ? 'no' : ''}" style="${x.type === 'changed' ? 'color:var(--warn);font-weight:600' : ''}">${x.type}</span></td>
      <td>${'before' in x ? cell(x.before) : ''}</td><td>${'after' in x ? cell(x.after) : ''}</td></tr>`).join('');
    res.innerHTML = warn + `<div class="verdict ${verdict}"><b>${verdict.toUpperCase()}</b><span>${cnt('fail')} fail · ${cnt('warn')} warn · ${cnt('pass')} pass · ${cnt('info')} info</span>
        <span class="grow"></span><button class="tool" id="xh">Export HTML</button><button class="tool" id="xc">Export CSV</button><button class="tool" id="xj">Export JSON</button></div>
      <h4 class="sub">Verdicts</h4><div class="scroll" style="max-height:40vh"><table><thead><tr><th>Rule</th><th>Scope</th><th>Level</th><th>Message</th></tr></thead><tbody>${frows || '<tr><td colspan="4" class="nul">No rules applied (snapshot has none of the checked data).</td></tr>'}</tbody></table></div>
      <header style="border-top:1px solid var(--bd)"><h4 class="sub" style="margin:0">Changes</h4><span class="badge">${esc(A.collected_at || '?')} → ${esc(B.collected_at || '?')}</span><span class="grow"></span>
      <span class="badge ok">+${n('added')} added</span><span class="badge bad">−${n('removed')} removed</span><span class="badge">${n('changed')} changed</span>
      <input class="filter" placeholder="filter…" data-f="cres"></header>` +
      (changes.length ? `<div class="scroll"><table><thead><tr><th>Path</th><th>Change</th><th>Before</th><th>After</th></tr></thead><tbody>${crows}</tbody></table></div>` +
        (changes.length > 1000 ? `<div class="note">Showing 1000 of ${changes.length} – exports contain all.</div>` : '') : '<div class="msg good">No differences.</div>');
    const base = `comparison_${(B.target || 'x')}_${new Date().toISOString().replace(/[:.]/g, '-')}`;
    $('xh').onclick = () => saveText(base + '.html', reportHtml(lastCmp), 'text/html');
    $('xc').onclick = () => saveText(base + '.csv', toCsv(changes), 'text/csv');
    $('xj').onclick = () => saveText(base + '.json', J({ before: { source: A.source, target: A.target, collected_at: A.collected_at, label: A.label }, after: { source: B.source, target: B.target, collected_at: B.collected_at, label: B.label }, verdict, findings, changes }, null, 2), 'application/json');
  };
};

// ---- sessions box: full session table of the selected FortiGate + validation ----
$('sess').onclick = () => {
  const dev = $('dev').value;
  active = null; paintChips();
  $('out').innerHTML = `<div class="card"><header><h3>Sessions · ${esc(dev)}</h3><span class="badge">monitor/firewall/session</span></header>
    <div class="body"><label>Max sessions <select id="scount"><option>100</option><option selected>1000</option><option>5000</option><option>20000</option></select></label>
    <label>IP version <select id="sipv"><option>ipv4</option><option>ipv6</option><option>both</option></select></label>
    <button class="tool" id="sgo">Fetch sessions</button> <button class="tool" id="sgol" title="Query the device live, bypassing the cache">↻ Fetch live</button><div id="sval"></div><div id="sres"></div></div></div>`;
  const fetchSessions = async refresh => {
    const q = ($('vdom').value ? '&vdom=' + encodeURIComponent($('vdom').value) : ''), base = `/api/fgt/${encodeURIComponent(dev)}/sessions`;
    $('sval').innerHTML = $('sres').innerHTML = '<div class="msg">Fetching…</div>';
    call(`${base}/validate?${q.slice(1)}`, refresh).then(v => {
      const S = v.sessions, st = (t, val, sub, cls = '') => `<div class="stat ${cls}"><small>${t}</small><b>${esc(val ?? '–')}</b>${sub ? `<i>${sub}</i>` : ''}</div>`;
      $('sval').innerHTML = `<div class="stats">${st('Verdict', v.level, '', v.level)}${st('IPv4 sessions', S.session.current, `recent avg ${S.session.recent_average ?? '–'}`)}` +
        `${st('IPv6 sessions', S.session6.current, `recent avg ${S.session6.recent_average ?? '–'}`)}${S.setup_rate != null ? st('New sessions/s', S.setup_rate) : ''}</div>` +
        v.findings.map(f => `<div class="note ${{ fail: 'no', warn: '', pass: 'good' }[f.level] || ''}">${esc(f.msg)}</div>`).join('');
    }, e => $('sval').innerHTML = `<div class="msg err">${esc(e.message)}</div>`);
    const t = performance.now();
    try {
      var st = { data: await call(`${base}?count=${$('scount').value}&ip_version=${$('sipv').value}${q}`, refresh) };
    } catch (e) { st = { error: e.message }; }
    st.ms = Math.round(performance.now() - t);
    $('sres').innerHTML = card(`${dev} · sessions`, 'session table', st);
  };
  $('sgo').onclick = () => fetchSessions(false);
  $('sgol').onclick = () => fetchSessions(true);
};

// ---- chips / chrome -------------------------------------------------------
// consistent 24px line icons (stroke = currentColor)
const P = {
  pulse:'<path d="M3 12h4l3-8 4 16 3-8h4"/>',
  cpu:'<rect x="5" y="5" width="14" height="14" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3"/>',
  ha:'<rect x="3" y="4" width="7" height="6" rx="1"/><rect x="14" y="14" width="7" height="6" rx="1"/><path d="M10 7h4a3 3 0 0 1 3 3v4"/>',
  hash:'<path d="M5 9h14M5 15h14M10 4L8 20M16 4l-2 16"/>',
  layers:'<path d="M12 3l9 5-9 5-9-5 9-5z"/><path d="M3 13l9 5 9-5"/>',
  server:'<rect x="3" y="4" width="18" height="6" rx="1.5"/><rect x="3" y="14" width="18" height="6" rx="1.5"/><path d="M7 7h.01M7 17h.01"/>',
  list:'<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  search:'<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
  grid:'<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  users:'<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 7M18 14a6.5 6.5 0 0 1 3.5 6"/>',
  shield:'<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3z"/><path d="M9 12l2 2 4-4"/>',
  tasks:'<rect x="6" y="4" width="12" height="17" rx="2"/><path d="M9 4h6v3H9zM9 14l2 2 4-4"/>',
  port:'<rect x="3" y="7" width="18" height="10" rx="1.5"/><path d="M7 17v3M12 17v3M17 17v3M7 7v3M12 7v3M17 7v3"/>',
  sliders:'<path d="M4 6h8M18 6h2M4 12h2M12 12h8M4 18h10M20 18h0"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>',
  route:'<circle cx="6" cy="19" r="2.5"/><circle cx="18" cy="5" r="2.5"/><path d="M8.5 19H16a3.5 3.5 0 0 0 0-7H8a3.5 3.5 0 0 1 0-7h7.5"/>',
  pin:'<path d="M12 21s-7-6.2-7-11a7 7 0 0 1 14 0c0 4.8-7 11-7 11z"/><circle cx="12" cy="10" r="2.5"/>',
  table:'<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M9 10v10"/>',
  globe:'<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18"/>',
  lock:'<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  wifi:'<path d="M2.5 9a15 15 0 0 1 19 0M5.5 12.5a10 10 0 0 1 13 0M8.5 16a5 5 0 0 1 7 0"/><circle cx="12" cy="19.5" r="1"/>',
  id:'<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="11" r="2"/><path d="M5.5 16a3.5 3.5 0 0 1 7 0M15 10h3M15 14h3"/>',
  dot:'<circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="9"/>',
  play:'<path d="M7 4l13 8-13 8z"/>',
  refresh:'<path d="M20 11a8 8 0 1 0-2.3 6.3M20 4v7h-7"/>',
  download:'<path d="M12 4v11M7 11l5 5 5-5M5 20h14"/>',
  compare:'<path d="M4 8h14M14 4l4 4-4 4M20 16H6M10 12l-4 4 4 4"/>',
};
const svg = n => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[n] || P.dot}</svg>`;
const ICON = { system_status:'pulse', resources:'cpu', ha_status:'ha', ha_peers:'ha', ha_checksums:'hash', adoms:'layers', devices:'server', inventory:'list',
  device_detail:'search', device_vdoms:'grid', vdoms:'grid', device_groups:'users', policy_packages:'shield', tasks:'tasks', interfaces:'port',
  interface_cfg:'sliders', routes:'route', static_routes:'pin', arp:'table', bgp:'globe', ipsec:'lock', sdwan:'wifi', license:'id' };
document.querySelectorAll('[data-i]').forEach(e => e.innerHTML = svg(e.dataset.i));
function paintChips() {
  $('chips').innerHTML = available()
    .map(([k, d]) => `<button class="chip ${k === active ? 'on' : ''}" data-chip="${k}" title="${esc(d)}"><span class="ico">${svg(ICON[k])}</span><b>${esc(k.replace(/_/g, ' '))}</b><small>${esc(d)}</small></button>`).join('')
    || '<div class="msg">No checks available.</div>';
}
// VDOM dropdown: pulled from the selected FortiGate (cached), previous choice or root pre-selected
async function loadVdoms() {
  if (mode !== 'fgt') return;
  const dev = $('dev').value, sel = $('vdom');
  if (!dev) { sel.innerHTML = '<option value="">VDOM…</option>'; return; }
  sel.disabled = true;
  let names = [];
  try { names = (unwrap(await call(`/api/fgt/${encodeURIComponent(dev)}/vdoms`))[0] || []).map(v => v.name).filter(Boolean); }
  catch (e) { /* device unreachable: fall back to its default VDOM */ }
  if ($('dev').value !== dev) return;  // another device was picked meanwhile
  sel.innerHTML = names.length ? names.map(n => `<option>${esc(n)}</option>`).join('') : '<option value="">default VDOM</option>';
  const saved = ls.get('vdom:' + dev);
  sel.value = names.includes(saved) ? saved : names.includes('root') ? 'root' : names[0] || '';
  sel.disabled = false;
}
$('vdom').onchange = () => ls.set('vdom:' + $('dev').value, $('vdom').value);
$('dev').onchange = loadVdoms;
function render() {
  active = null; $('out').innerHTML = '<div class="msg" data-idle>Pick a check above.</div>'; $('status').innerHTML = '';
  $('dev').style.display = $('vdom').style.display = mode === 'fgt' ? '' : 'none';
  $('adom').style.display = $('fdev').style.display = mode === 'fmg' ? '' : 'none';
  $('sess').hidden = mode === 'fmg';  // sessions are a FortiGate-only view
  $('dev').innerHTML = cat.devices.map(d => `<option>${esc(d)}</option>`).join('');
  const sd = ls.get('fgt_dev'); if (sd && cat.devices.includes(sd)) $('dev').value = sd;
  updateCli();
  if (mode === 'fmg' && cat.fmg_configured)
    adoms.length || loadAdoms().then(loadDevices);  // only fills the dropdown/sidebar; nothing is run until the user picks a check
  $('tFmg').classList.toggle('on', mode === 'fmg'); $('tFgt').classList.toggle('on', mode === 'fgt');
  paintChips(); paintInv();
  loadVdoms();
}
const post = u => fetch(u, { method: 'POST', headers: { 'X-Requested-With': 'dashboard' } });
$('out_').onclick = () => post('/api/logout').then(() => location.href = '/login');
$('clr').onclick = () => post('/api/cache/clear').then(r => r.json()).then(j => { $('clr').textContent = `Cleared ${j.cleared}`; setTimeout(() => $('clr').textContent = 'Clear cache', 1500); });
// each tab keeps the results it was showing, so switching back needs no new request
const views = {};
function switchMode(m) {
  if (m === mode) return;
  views[mode] = { html: $('out').innerHTML, active };
  mode = m; ls.set('mode', mode); render();
  const v = views[m];
  if (v) { $('out').innerHTML = v.html; active = v.active; paintChips(); }
}
$('tFmg').onclick = () => switchMode('fmg');
$('tFgt').onclick = () => switchMode('fgt');
function updateCli() {
  const a = $('adom').value === '*' ? '<adom>' : $('adom').value;
  $('cli').innerHTML = mode === 'fmg' ? 'CLI-only, not available via API: ' + cat.fmg_cli_only.map(c => `<code>${esc(c.replace('{adom}', a))}</code>`).join(' ') : '';
}
$('adom').onchange = () => { ls.set('adom', $('adom').value); updateCli(); };
$('fdev').onchange = () => { $('adom').disabled = !!$('fdev').value; active = null; paintChips(); };

document.addEventListener('click', async e => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.dataset.rw) {  // resource dashboard: switch every chart to another history window
    setWin(b.closest('.res'), b.dataset.rw); return;
  }
  if (b.dataset.chip) return runCheck(b.dataset.chip, e.shiftKey);  // Shift+click = live
  if (b.dataset.dev !== undefined) return pickDevice(b.dataset.dev);
  if (b.dataset.t) {
    const [id, v] = b.dataset.t.split(':'), c = $(id);
    c.querySelectorAll('[data-t]').forEach(x => x.classList.toggle('on', x === b));
    c.querySelectorAll('[data-p]').forEach(p => p.hidden = p.dataset.p !== `${id}:${v}`);
  } else if (b.dataset.rf) {
    const q = reqs[b.dataset.rf]; b.disabled = true; b.textContent = 'Refreshing…';
    $(b.dataset.rf).outerHTML = await fetchCard(q.url, q.name, q.desc, true, q.check);
  } else if (b.dataset.c) {
    navigator.clipboard.writeText(JSON.stringify(store[b.dataset.c], null, 2)); b.textContent = 'Copied';
    setTimeout(() => b.textContent = 'Copy', 1200);
  } else if (b.dataset.d) {
    const [id, name] = b.dataset.d.split(':');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(store[id], null, 2)], { type: 'application/json' }));
    a.download = name.replace(/[^\w.-]+/g, '_') + '.json'; a.click();
  }
});
document.addEventListener('change', e => { if (e.target.dataset.rwsel !== undefined) setWin(e.target.closest('.res'), e.target.value); });
document.addEventListener('input', e => {
  if (!e.target.dataset.f) return;
  const q = e.target.value.toLowerCase();
  $(e.target.dataset.f).querySelectorAll('[data-s]').forEach(r => r.hidden = !r.dataset.s.includes(q));
});

call('/api/catalog').then(c => {
  cat = c; render();
  call('/api/health').then(h => { hl = h; paintInv(); }, () => {});
  if (!c.fmg_configured) $('out').innerHTML = '<div class="msg err">FMG_HOST / FMG_TOKEN not set (FortiManager checks will fail).</div>';
});
