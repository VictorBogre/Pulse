// Per-check views: summary tiles, status pills and readable units. Loaded before app.js; uses its esc(), svg(), table(), kv().

// ---- formatters ----
const fmtBytes = n => { n = +n; if (!isFinite(n)) return '–'; const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; } return (i ? n.toFixed(n >= 100 ? 0 : 1) : n) + ' ' + u[i]; };
const fmtDur = s => { s = Math.round(+s); if (!isFinite(s)) return '–'; const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60); return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : m ? `${m}m ${s % 60}s` : `${s}s`; };
const fmtSpeed = m => m >= 1000 ? `${m / 1000} Gbps` : `${m} Mbps`;
const fmtDate = v => new Date(v > 1e12 ? v : v * 1000).toLocaleString([], { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const isEpoch = v => typeof v === 'number' && v > 1e9 && v < 4e12;

// status text -> ok | bad | warn | run | mut | '' (colour class)
const lvl = s => {
  s = String(s).toLowerCase().replace(/[\s_-]/g, '');
  if (/eval/.test(s)) return 'warn';
  if (/^(up|connected|established|alive|enable|enabled|ok|insync|synchronized|true|valid|licensed|success|done|pass|installed|primary|master|available|registered|healthy)$/.test(s)) return 'ok';
  if (/^(down|disconnected|failed|fail|disable|disabled|idle|outofsync|error|false|expired|dead|aborted|cancelled|invalid|unreachable)$/.test(s)) return 'bad';
  if (/^(pending|warning|warn|partial|connect|active|opensent|openconfirm|modified|degraded|cancelling|aborting|tocontinue|expiring)$/.test(s)) return 'warn';
  if (/^(running|inprogress)$/.test(s)) return 'run';
  if (/^(unknown|nosupport|unregistered|unregistrable|notregistered|notsupported|none|na)$/.test(s)) return 'mut';
  return '';
};
const pill = (txt, l) => `<span class="pill ${l || 'mut'}">${esc(txt)}</span>`;
const bar = (v, load = true) => `<div class="pbar ${!load ? '' : v >= 90 ? 'bad' : v >= 70 ? 'warn' : 'ok'}" title="${v}%"><i style="width:${Math.min(100, Math.max(0, v))}%"></i><span>${v}%</span></div>`;
const stat = (t, val, sub, cls = '') => `<div class="stat ${cls}"><small>${esc(t)}</small><b>${esc(val ?? '–')}</b>${sub ? `<i>${esc(sub)}</i>` : ''}</div>`;
const stats = list => `<div class="stats">${list.join('')}</div>`;
const empty = msg => `<div class="empty"><div class="eico">${svg('dot')}</div>${esc(msg)}</div>`;
const more = (title, html) => `<details class="more"><summary>${esc(title)}</summary>${html}</details>`;
const idc = (t, v) => v == null || v === '' ? '' : `<div class="idc"><small>${esc(t)}</small><b>${esc(v)}</b></div>`;

// FortiManager numeric enums (strings are accepted too)
const ENUM = { conn_status: { 0: 'unknown', 1: 'up', 2: 'down' }, conf_status: { 0: 'unknown', 1: 'in sync', 2: 'out of sync' }, db_status: { 0: 'unknown', 1: 'unmodified', 2: 'modified' } };
const enumTxt = (k, v) => typeof v === 'string' ? v.toLowerCase() : (ENUM[k] || {})[v] ?? String(v);

// one table cell, aware of the column name (status pills, bytes, dates, speeds, progress bars)
function cellK(k, v) {
  if (v === null || v === undefined || v === '') return cell(v);
  if (ENUM[k]) { const t = enumTxt(k, v); return pill(t, lvl(t)); }
  if (typeof v === 'boolean') {
    if (k === 'link') return pill(v ? 'up' : 'down', v ? 'ok' : 'bad');
    if (k === 'admin_status') return pill(v ? 'enabled' : 'disabled', v ? 'ok' : 'bad');
    if (k === 'master') return pill(v ? 'primary' : 'secondary', v ? 'ok' : 'mut');
  }
  if (typeof v === 'number') {
    if (/(^|_)bytes$/.test(k)) return `<span title="${v.toLocaleString()} bytes">${fmtBytes(v)}</span>`;
    if (k === 'speed') return v ? fmtSpeed(v) : '<span class="nul">–</span>';
    if (/^(uptime|age)$/.test(k)) return fmtDur(v);
    if (/^(latency|jitter)$/.test(k)) return `${+v.toFixed(2)} ms`;
    if (/packet_loss$/.test(k)) return `${v}%`;
    if (k === 'percent') return bar(v, false);
    if (/^(cpu_usage|memory_usage|mem_usage)$/.test(k)) return bar(v);
    if (/(_tm|time|_update|expire|expires|date)$/i.test(k)) { if (v === 0) return '<span class="nul">–</span>'; if (isEpoch(v)) return `<span class="nw" title="${v}">${fmtDate(v)}</span>`; }
  }
  if (typeof v === 'string' && /^(status|state)$/.test(k)) { const l = lvl(v); if (l) return pill(v, l); }
  if (typeof v === 'string' && /^(enable|disable|enabled|disabled)$/i.test(v)) return esc(v);
  return cell(v);
}

// ---- helpers shared by views ----
const isMapOf = (d, key) => d && typeof d === 'object' && !Array.isArray(d) && Object.values(d).length && Object.values(d).every(x => x && typeof x === 'object' && key in x);
const countBy = (rows, f) => rows.reduce((m, r) => { const k = f(r); m[k] = (m[k] || 0) + 1; return m; }, {});
const verOf = r => { if (r.os_ver == null || isNaN(+r.os_ver)) return ''; const b = `${Math.trunc(+r.os_ver)}.${r.mr ?? 0}`; return r.patch != null ? `${b}.${r.patch}` : b; };
const withVer = rows => rows.map(r => { if (!('os_ver' in r)) return r; const { os_ver, mr, patch, ...rest } = r; return { ...rest, version: verOf(r) }; });
const lc = o => Object.fromEntries(Object.entries(o).map(([k, v]) => [k.toLowerCase(), v]));
const pick = (o, ...ks) => { for (const k of ks) if (o[k] !== undefined && o[k] !== '') return o[k]; };

// ---- views, keyed by check name; return html or null to fall back to the generic table ----
const VIEW = {};

// identity header: hostname, model, version, serial (FortiGate and FortiManager)
VIEW.system_status = (d, meta) => {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return null;
  const m = Object.fromEntries(meta.map(x => { const i = x.indexOf(': '); return [x.slice(0, i), x.slice(i + 2)]; })), o = lc(d);
  const host = pick(o, 'hostname'), model = o.model_name ? `${o.model_name} ${o.model_number || ''}`.trim() : pick(o, 'platform type', 'platform_str', 'model');
  const ver = m.version || pick(o, 'version'), build = m.build || pick(o, 'build');
  const head = `<div class="hero2"><div><h4>${esc(host || 'Device')}</h4><div class="sub2">${esc(model || '')}</div></div><div class="idgrid">` +
    idc('Version', ver && build && !String(ver).includes('build') ? `${ver} (build ${build})` : ver) + idc('Serial', m.serial || pick(o, 'serial number', 'serial')) + idc('VDOM', m.vdom) + '</div></div>';
  const tiles = [['log_disk_status', 'Log disk'], ['ha mode', 'HA mode'], ['license status', 'License'], ['fips mode', 'FIPS mode'], ['admin domain configuration', 'ADOMs'], ['current time', 'Time']]
      .filter(([k]) => o[k] !== undefined && o[k] !== '').map(([k, t]) => { const l = ['log_disk_status', 'license status'].includes(k) ? lvl(o[k]) : ''; return stat(t, o[k], '', l === 'ok' ? 'pass' : l === 'bad' ? 'fail' : ''); });
  return head + (tiles.length ? stats(tiles) : '') + more('All fields', kv(d));
};

// port tiles
VIEW.interfaces = d => {
  if (!isMapOf(d, 'link')) return null;
  const ports = Object.values(d).sort((a, b) => (b.link - a.link) || String(a.name).localeCompare(b.name)), up = ports.filter(p => p.link).length;
  const errs = ports.reduce((s, p) => s + (p.rx_errors || 0) + (p.tx_errors || 0), 0);
  const tile = p => {
    const hasIp = p.ip && p.ip !== '0.0.0.0', e = (p.rx_errors || 0) + (p.tx_errors || 0);
    return `<div class="port ${p.link ? 'up' : 'down'}" data-s="${esc(JSON.stringify(p).toLowerCase())}"><div class="ph"><i class="led"></i><b>${esc(p.name)}</b><span>${esc(p.alias || '')}</span></div>` +
      `<div class="pip">${hasIp ? `${esc(p.ip)}/${p.mask}` : '<span class="nul">no IP</span>'}</div>` +
      `<div class="pmeta">${p.link ? `${fmtSpeed(p.speed)} · ${p.duplex ? 'full' : 'half'} duplex` : 'link down'}</div>` +
      `<div class="ptr"><span title="${(p.rx_packets || 0).toLocaleString()} packets">↓ ${fmtBytes(p.rx_bytes)}</span><span title="${(p.tx_packets || 0).toLocaleString()} packets">↑ ${fmtBytes(p.tx_bytes)}</span></div>` +
      `<div class="pe ${e ? 'bad' : ''}">${e ? `errors rx ${p.rx_errors} / tx ${p.tx_errors}` : 'no errors'} · <span class="mac">${esc(p.mac || '')}</span></div></div>`;
  };
  return stats([stat('Interfaces', ports.length), stat('Link up', up, '', up ? 'pass' : ''), stat('Link down', ports.length - up), stat('Errors', errs, '', errs ? 'fail' : '')]) +
    `<div class="pgrid">${ports.map(tile).join('')}</div>`;
};

VIEW.interface_cfg = d => {
  if (!Array.isArray(d) || !d.length) return null;
  const only = ['name', 'alias', 'ip', 'allowaccess', 'mode', 'type', 'role', 'status', 'vdom', 'vlanid', 'interface', 'mtu', 'description'];
  return table(d, { only }) + `<div class="note">Key columns only · the JSON tab has all ${Object.keys(d[0]).length} fields per interface.</div>`;
};

VIEW.static_routes = d => {
  if (!Array.isArray(d) || !d.length) return null;
  return table(d, { only: ['seq-num', 'status', 'dst', 'gateway', 'device', 'distance', 'priority', 'weight', 'blackhole', 'comment', 'vrf'] }) +
    `<div class="note">Key columns only · the JSON tab has all fields.</div>`;
};

VIEW.routes = d => {
  if (!Array.isArray(d) || !d.length || !('ip_mask' in d[0])) return null;
  const t = countBy(d, r => r.type === 'connect' ? 'connected' : r.type || 'other'), def = d.find(r => r.ip_mask === '0.0.0.0/0');
  const tiles = [stat('Routes', d.length), ...Object.entries(t).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, n]) => stat(k, n)),
    stat('Default route', def ? def.gateway : 'missing', def ? `via ${def.interface}` : '', def ? 'pass' : 'fail')];
  return stats(tiles) + table(d, { first: ['ip_mask', 'type', 'gateway', 'interface', 'distance', 'metric', 'priority'], hide: ['non_rc_gateway', 'origin'] });
};

VIEW.arp = d => {
  if (!Array.isArray(d) || !d.length) return null;
  return stats([stat('ARP entries', d.length), ...Object.entries(countBy(d, r => r.interface)).slice(0, 5).map(([k, n]) => stat(k, n))]) +
    table(d, { first: ['ip', 'mac', 'interface', 'age'] });
};

VIEW.bgp = d => {
  if (!Array.isArray(d) || !d.length || !('neighbor_ip' in d[0])) return null;
  const est = d.filter(n => lvl(n.state) === 'ok').length;
  return stats([stat('Neighbors', d.length), stat('Established', est, '', est === d.length ? 'pass' : est ? 'warn' : 'fail'), stat('Not established', d.length - est, '', d.length - est ? 'warn' : '')]) +
    table(d, { first: ['neighbor_ip', 'remote_as', 'state', 'type', 'admin_status', 'local_ip'] });
};

VIEW.ipsec = d => {
  if (!Array.isArray(d) || !d.length) return null;
  const sum = (px, k) => px.reduce((s, p) => s + (p[k] || 0), 0);
  const rows = d.map(t => {
    const px = t.proxyid || [], up = px.filter(p => /^up$/i.test(p.status)).length;
    return { name: t.name, remote_gateway: t.rgwy, status: !px.length ? 'down' : up === px.length ? 'up' : up ? 'partial' : 'down', 'phase2_up': `${up}/${px.length}`,
      incoming_bytes: t.incoming_bytes ?? sum(px, 'incoming_bytes'), outgoing_bytes: t.outgoing_bytes ?? sum(px, 'outgoing_bytes'), type: t.type, comments: t.comments };
  });
  const n = s => rows.filter(r => r.status === s).length;
  return stats([stat('Tunnels', rows.length), stat('Up', n('up'), '', n('up') === rows.length ? 'pass' : ''), stat('Partial', n('partial'), '', n('partial') ? 'warn' : ''), stat('Down', n('down'), '', n('down') ? 'fail' : '')]) + table(rows);
};

VIEW.ha_peers = d => {
  if (Array.isArray(d) && !d.length) return empty('Standalone: no HA peers reported (this unit is not in an HA cluster).');
  if (!Array.isArray(d) || !d[0] || !('serial_no' in d[0] || 'hostname' in d[0])) return null;
  const card = p => {
    const rest = Object.entries(p).filter(([k, v]) => !['hostname', 'serial_no', 'master', 'priority', 'cpu_usage', 'memory_usage', 'vcluster_id'].includes(k) && typeof v !== 'object');
    return `<div class="member ${p.master ? 'primary' : ''}" data-s="${esc(JSON.stringify(p).toLowerCase())}"><div class="mh"><b>${esc(p.hostname || p.serial_no)}</b>${pill(p.master ? 'Primary' : 'Secondary', p.master ? 'ok' : 'mut')}</div>` +
      `<div class="mk"><small>Serial</small><span class="mac">${esc(p.serial_no || '–')}</span></div><div class="mk"><small>Priority</small><span>${esc(p.priority ?? '–')}</span></div>` +
      (p.cpu_usage != null ? `<div class="mk"><small>CPU</small>${bar(p.cpu_usage)}</div>` : '') + (p.memory_usage != null ? `<div class="mk"><small>Memory</small>${bar(p.memory_usage)}</div>` : '') +
      rest.slice(0, 6).map(([k, v]) => `<div class="mk"><small>${esc(nice(k))}</small><span>${cellK(k, v)}</span></div>`).join('') + '</div>';
  };
  return stats([stat('Members', d.length), stat('Primary', d.filter(p => p.master).length)]) + `<div class="mgrid">${d.map(card).join('')}</div>`;
};
VIEW.ha_checksums = d => Array.isArray(d) && !d.length ? empty('No HA checksums: this unit is not in an HA cluster.') : null;

// FortiGuard / FortiCare / signature databases, one tile per service
VIEW.license = d => {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return null;
  const ents = Object.entries(d).filter(([, v]) => v && typeof v === 'object' && !Array.isArray(v));
  if (!ents.length) return null;
  const st = v => v.status ?? ('connected' in v ? (v.connected ? 'connected' : 'not connected') : '');
  const lic = ents.map(([k, v]) => { const s = st(v); return [k, v, s, lvl(s) || 'mut']; });
  const n = l => lic.filter(x => x[3] === l).length;
  const tile = ([k, v, s, l]) => {
    const rows = [['Version', v.version], ['Entitlement', v.entitlement], ['Engine', v.engine && v.engine.version], ['Updated', isEpoch(v.last_update) && v.last_update > 1e9 ? fmtDate(v.last_update) : ''],
      ['Next update', isEpoch(v.next_scheduled_update) ? fmtDate(v.next_scheduled_update) : ''], ['Expires', isEpoch(v.expires) ? fmtDate(v.expires) : ''], ['Registration', v.registration_status]].filter(([, x]) => x);
    return `<div class="lic ${l}" data-s="${esc((k + JSON.stringify(v)).toLowerCase())}"><div class="lh"><b>${esc(nice(k))}</b>${pill(String(s).replace(/_/g, ' ') || '–', l)}</div>` +
      rows.map(([a, b]) => `<div class="lk"><small>${a}</small><span>${esc(b)}</span></div>`).join('') + '</div>';
  };
  const key = x => x[3] !== 'mut' || ['fortiguard', 'forticare', 'forticloud'].includes(x[0]), main = lic.filter(key), rest = lic.filter(x => !key(x));
  const chips = rest.map(([k, v, s]) => `<span class="chip2" data-s="${esc((k + JSON.stringify(v)).toLowerCase())}" title="${esc(String(s).replace(/_/g, ' '))}${v.version ? ' · version ' + esc(v.version) : ''}">${esc(nice(k))}</span>`).join('');
  return stats([stat('Services', lic.length), stat('Licensed / OK', n('ok'), '', n('ok') ? 'pass' : ''), stat('Not licensed', n('mut')), stat('Warning', n('warn'), '', n('warn') ? 'warn' : ''), stat('Expired / failed', n('bad'), '', n('bad') ? 'fail' : '')]) +
    `<div class="lgrid">${main.map(tile).join('')}</div>` + (rest.length ? more(`${rest.length} services not licensed / no support`, `<div class="chips2">${chips}</div>`) : '');
};

// SD-WAN health checks: one row per member
VIEW.sdwan = d => {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return null;
  const rows = [];
  for (const [hc, mem] of Object.entries(d)) for (const [m, v] of Object.entries(mem || {})) rows.push({ health_check: hc, member: m, status: v.status, latency: v.latency, jitter: v.jitter, packet_loss: v.packet_loss, packet_sent: v.packet_sent, packet_received: v.packet_received, sla_targets_met: v.sla_targets_met });
  if (!rows.length) return empty('SD-WAN health checks exist, but no member is reporting (SD-WAN is not in use on this FortiGate).');
  const alive = rows.filter(r => lvl(r.status) === 'ok').length;
  return stats([stat('Health checks', Object.keys(d).length), stat('Members alive', alive, '', alive === rows.length ? 'pass' : 'warn'), stat('Members dead', rows.length - alive, '', rows.length - alive ? 'fail' : '')]) + table(rows);
};

// FortiManager
const fmgDevices = d => {
  if (!Array.isArray(d) || !d.length || !('sn' in d[0] || 'conn_status' in d[0])) return null;
  const c = (k, t) => d.filter(r => enumTxt(k, r[k]) === t).length;
  return stats([stat('Devices', d.length), stat('Connected', c('conn_status', 'up'), '', c('conn_status', 'up') === d.length ? 'pass' : ''), stat('Disconnected', c('conn_status', 'down'), '', c('conn_status', 'down') ? 'fail' : ''),
    stat('Config in sync', c('conf_status', 'in sync')), stat('Out of sync', c('conf_status', 'out of sync'), '', c('conf_status', 'out of sync') ? 'warn' : ''), stat('DB modified', c('db_status', 'modified'), '', c('db_status', 'modified') ? 'warn' : '')]) +
    table(withVer(d), { first: ['name', 'ip', 'sn', 'platform_str', 'version', 'build', 'conn_status', 'conf_status', 'db_status', 'ha_mode', 'ha_group_name'] });
};
VIEW.devices = fmgDevices;
VIEW.inventory = fmgDevices;
VIEW.adoms = d => Array.isArray(d) && d.length ? stats([stat('ADOMs', d.length)]) + table(withVer(d), { first: ['name', 'oid', 'version', 'state', 'desc'] }) : null;

VIEW.device_detail = d => {
  const r = Array.isArray(d) ? d[0] : d;
  if (!r || typeof r !== 'object' || !('name' in r)) return null;
  const head = `<div class="hero2"><div><h4>${esc(r.name)}</h4><div class="sub2">${esc(r.platform_str || '')}</div></div><div class="idgrid">` +
    idc('IP', r.ip) + idc('Version', verOf(r) + (r.build ? ` (build ${r.build})` : '')) + idc('Serial', r.sn) + idc('Hostname', r.hostname) + '</div></div>';
  const tiles = ['conn_status', 'conf_status', 'db_status'].filter(k => k in r).map(k => { const t = enumTxt(k, r[k]), l = lvl(t); return stat(nice(k.replace('_status', ' status')), t, '', l === 'ok' ? 'pass' : l === 'bad' ? 'fail' : l === 'warn' ? 'warn' : ''); });
  return head + (tiles.length ? stats(tiles) : '') + more('All fields', kv(r));
};

const TASK = { 0: 'pending', 1: 'running', 2: 'cancelling', 3: 'cancelled', 4: 'done', 5: 'error', 6: 'aborting', 7: 'aborted', 8: 'warning', 9: 'to continue', 10: 'unknown' };
VIEW.tasks = d => {
  if (!Array.isArray(d) || !d.length) return null;
  const rows = d.map(t => ({ ...t, state: typeof t.state === 'number' ? (TASK[t.state] || t.state) : t.state })), n = s => rows.filter(r => r.state === s).length;
  return stats([stat('Tasks', rows.length), stat('Running', n('running')), stat('Done', n('done'), '', n('done') ? 'pass' : ''), stat('Errors', n('error') + n('aborted'), '', n('error') + n('aborted') ? 'fail' : ''), stat('Warnings', n('warning'), '', n('warning') ? 'warn' : '')]) +
    table(rows, { first: ['id', 'title', 'state', 'percent', 'user', 'adom', 'src', 'start_tm', 'end_tm', 'num_done', 'num_err', 'num_warn'] });
};

VIEW.ha_status = d => {
  if (!d || typeof d !== 'object' || Array.isArray(d) || d.mode === undefined) return null;
  return stats([stat('HA mode', d.mode, '', d.mode === 'standalone' ? '' : 'pass'), ...(d['cluster-id'] != null ? [stat('Cluster ID', d['cluster-id'])] : []), ...(d['cluster-name'] ? [stat('Cluster name', d['cluster-name'])] : [])]) + more('All fields', kv(d));
};

const EMPTY = { ipsec: 'No IPsec tunnels.', bgp: 'No BGP neighbors configured.', arp: 'The ARP table is empty.', routes: 'The routing table is empty.', static_routes: 'No static routes configured.',
  tasks: 'No recent tasks.', device_groups: 'No device groups.', policy_packages: 'No policy packages in this ADOM.', devices: 'No devices in this ADOM.', inventory: 'No devices in this ADOM.',
  adoms: 'No ADOMs.', device_vdoms: 'No VDOMs.', vdoms: 'No VDOMs.', interface_cfg: 'No interface configuration returned.' };

// entry point used by view(): custom view for the check, else a friendly empty state, else null (generic table)
function viewFor(d, meta, check) {
  if (VIEW[check]) { const h = VIEW[check](d, meta || []); if (h) return h; }
  if (Array.isArray(d) && !d.length && EMPTY[check]) return empty(EMPTY[check]);
  return null;
}
