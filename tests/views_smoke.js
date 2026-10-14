// Smoke test for static/views.js + the table/cell code in static/app.js (run by tests/test_app.py, needs node).
// Renders each per-check view from sample data and checks for the expected markers; any exception fails the test.
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..', 'static');
const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8'), views = fs.readFileSync(path.join(root, 'views.js'), 'utf8');
const cut = (s, a, b) => { const i = s.indexOf(a), j = s.indexOf(b); if (i < 0 || j < 0) throw new Error(`markers not found: ${a} / ${b}`); return s.slice(i, j); };
const code = [
  "const esc = s => String(s).replace(/[&<>\"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;'}[c]));",
  "const GOOD = /^(up|ok)$/i; const BAD = /^(down|idle)$/i;",
  cut(app, 'function cell(v) {', 'const store = {}'),
  cut(app, 'const P = {', 'const ICON = {'),
  views,
  'return { view, unwrap, resView, isRes };',
].join('\n');
const { view, unwrap } = new Function(code)();
const now = Math.floor(Date.now() / 1000);
const render = (check, data) => { const [d, meta] = unwrap(data); return view(d, meta, check); };
const cases = [
  ['interfaces', { results: { port1: { name: 'port1', link: true, speed: 1000, duplex: 1, ip: '10.0.0.1', mask: 24, rx_bytes: 2048, tx_bytes: 4096, rx_errors: 0, tx_errors: 0, mac: 'aa' }, port2: { name: 'port2', link: false, ip: '0.0.0.0', mask: 0 } } }, ['port up', 'Link up', 'link down', '2.0 KB']],
  ['bgp', { results: [{ neighbor_ip: '1.1.1.1', remote_as: 1, state: 'Established' }, { neighbor_ip: '2.2.2.2', remote_as: 2, state: 'Idle' }] }, ['Established', 'pill bad', 'Not established']],
  ['routes', { results: [{ ip_mask: '0.0.0.0/0', type: 'static', gateway: '10.0.0.254', interface: 'port1', distance: 10 }] }, ['Default route', '10.0.0.254']],
  ['ipsec', { results: [{ name: 't1', rgwy: '9.9.9.9', proxyid: [{ status: 'up' }, { status: 'down' }] }] }, ['partial', '1/2']],
  ['ha_peers', { results: [] }, ['Standalone']],
  ['ha_peers', { results: [{ serial_no: 'S1', hostname: 'A', master: true, priority: 200, cpu_usage: 10 }] }, ['Primary', 'member primary']],
  ['sdwan', { results: { hc: {} } }, ['not in use']],
  ['license', { results: { antivirus: { status: 'licensed', version: '1' }, ips: { status: 'no_support' } } }, ['Antivirus', 'not licensed']],
  ['devices', [{ name: 'd1', sn: 'x', os_ver: 7, mr: 4, patch: 7, build: 1, conn_status: 1, conf_status: 2, db_status: 2 }], ['7.4.7', 'out of sync', 'modified', 'Connected']],
  ['tasks', [{ id: 1, title: 'x', state: 1, percent: 40, start_tm: now, end_tm: 0 }], ['running', 'pbar', '40%']],
  ['device_detail', { name: 'FGT', sn: 's', os_ver: 7, mr: 4, patch: 1, conn_status: 1, conf_status: 1, db_status: 1 }, ['FGT', 'in sync']],
  ['system_status', { results: { hostname: 'H1', model_name: 'FortiGate', model_number: 'VM64' }, version: 'v7.4.7', serial: 'S', build: 1 }, ['H1', 'v7.4.7 (build 1)']],
  ['tasks', [], ['No recent tasks']],
  ['unknown_check', [{ a: 1, b: 2 }], ['<table']],  // unknown checks still fall back to the generic table
  ['resources', { results: { cpu: [{ current: 5, historical: { '1-hour': { values: [[1, 1], [2, 5]], min: 1, max: 5, average: 3, start: 1000, end: 2000 } } }] } }, ['class="ring']],
];
let failed = 0;
for (const [check, data, expect] of cases) {
  let html = '';
  try { html = render(check, data); } catch (e) { console.log(`FAIL ${check}: threw ${e.message}`); failed++; continue; }
  const miss = expect.filter(x => !html.includes(x));
  if (miss.length) { console.log(`FAIL ${check}: missing ${JSON.stringify(miss)}`); failed++; }
}
if (failed) process.exit(1);
console.log(`ok ${cases.length} views`);
