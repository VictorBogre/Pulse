# Fortinet Dashboard: C4 architecture

Read-only web tool for checking FortiManager (FMG) and FortiGate (FGT) before and after changes.
Diagrams are Mermaid and render in GitHub, GitLab and the VS Code Markdown preview.

## Level 1: System context

```mermaid
flowchart TB
    eng(["Network / security engineer<br/><i>signs in, runs checks, takes PRE/POST snapshots, reviews verdicts</i>"])
    dash["<b>Fortinet Dashboard</b><br/>Login, read-only checks, result cache, snapshots, diff and verdicts"]
    fmg[("FortiManager<br/><i>inventory, ADOMs, policy packages, sync status</i>")]
    fgt[("FortiGates<br/><i>live state: routes, BGP, IPsec, HA, interfaces, sessions</i>")]

    eng -- "HTTPS (browser, login required)" --> dash
    dash -- "JSON-RPC over HTTPS<br/>method = get only" --> fmg
    dash -- "REST GET over HTTPS<br/>/api/v2/monitor, /cmdb" --> fgt
    fmg -. "manages" .-> fgt
```

## Level 2: Containers

```mermaid
flowchart TB
    eng(["Engineer"])

    subgraph dash ["Fortinet Dashboard (one Python process: uvicorn)"]
        spa["<b>Web page</b><br/>static/index.html + app.js + views.js + app.css, login.html<br/>vanilla JS, no build step<br/><i>UI, diff engine, verdict rules, exports</i>"]
        api["<b>API service</b><br/>app.py, FastAPI + httpx<br/><i>login gate, result cache, read-only device proxy, health, snapshot store</i>"]
        cache[("<b>Result cache</b><br/><i>in memory, TTL 5 min</i>")]
        cfg[("<b>devices.json</b> + <b>.env</b> / env vars<br/><i>hosts, token variable NAMES; tokens and login only in env</i>")]
        snaps[("<b>snapshots/</b> JSON files<br/><i>labelled pre/post, deleted after 7 days</i>")]
    end

    fmg[("FortiManager")]
    fgt[("FortiGates")]

    eng -- "browser" --> spa
    spa -- "fetch /api/* (session cookie)" --> api
    api -- "reads at startup" --> cfg
    api -- "get / store" --> cache
    api -- "read / write / purge" --> snaps
    api -- "JSON-RPC, Bearer token" --> fmg
    api -- "REST GET, Bearer token" --> fgt
```

Why the split: the browser never sees device tokens or talks to devices directly (TLS, CORS and
credentials stay on the server). The diff and verdict logic runs in the page so snapshots can also
be compared from uploaded files without a server round trip. The cache sits in the API service so
every browser action shares it and the devices are polled as little as possible.

## Level 3: Components

### API service (app.py)

```mermaid
flowchart LR
    req(["Request"]) --> gate["Gate middleware<br/><i>session cookie, CSRF header,<br/>sets per-request cache context</i>"]
    gate -- "no session" --> lg["/login, /api/login, /api/logout<br/><i>PBKDF2 password check,<br/>signed cookie, 5-fail throttle</i>"]
    gate --> cat["/api/catalog"]
    gate --> chk["/api/fmg/{check}<br/>/api/fgt/{name}/{check}<br/>/api/fgt/{name}/sessions[/validate]"]
    gate --> hl["/api/health<br/><i>always live</i>"]
    gate --> sn["/api/snapshots<br/><i>save, list (with expiry), get;<br/>7-day TTL purge</i>"]
    gate --> cc["/api/cache/clear"]
    gate --> st["/ and /static/*<br/><i>served after login</i>"]
    chk --> ca["_cached()<br/><i>TTL, per-key lock, ?refresh=true,<br/>errors not cached, X-Cache headers</i>"]
    ca --> cl["Client layer<br/>_fmg_raw() / _fgt_raw()<br/><i>GET / 'get' only, shared httpx client,<br/>timeout + concurrency cap</i>"]
    hl --> cl
    cl --> cfgc["Config loader<br/><i>.env, devices.json, env tokens</i>"]
    cl --> ext["FortiManager / FortiGates"]
    sn --> disk[("snapshots/")]
```

### Web page (static/app.js + static/views.js)

```mermaid
flowchart LR
    subgraph spa ["Web page"]
        top["Top bar + command bar<br/><i>FMG / FGT tabs, ADOM, device, VDOM dropdown<br/>(auto-filled from the FortiGate)</i>"]
        inv["Inventory panel<br/><i>FMG + FGT list, health dots</i>"]
        run["Check runner<br/><i>icon tiles, Run all, Refresh, Shift+click = live</i>"]
        view["Result renderer<br/><i>tables, JSON, filter, copy, download,<br/>cached-age badge, per-card Refresh</i>"]
        pv["Per-check views (views.js)<br/><i>port tiles, summary tiles, HA / license cards,<br/>status pills, readable units, empty states</i>"]
        res["Resource dashboard<br/><i>CPU / memory / disk gauges, history charts</i>"]
        col["Snapshot PRE / POST<br/><i>all checks, always live → JSON file + server copy</i>"]
        cmp["Compare engine<br/><i>deep diff, ignores volatile fields,<br/>newest PRE/POST pre-selected</i>"]
        rul["Verdict rules<br/><i>BGP, IPsec, interfaces, routes, HA, FMG sync</i>"]
        exp["Exports<br/><i>HTML, CSV, JSON</i>"]
        ses["Sessions view<br/><i>FortiGate tab only</i>"]
    end
    top --> run --> view
    view --> pv
    view --> res
    inv --> run
    col --> cmp --> rul --> exp
    run -. "/api/*" .-> api["API service"]
    col -. "/api/*" .-> api
    ses -. "/api/fgt/*/sessions" .-> api
    cmp -. "/api/snapshots" .-> api
```

## Key design decisions

| Decision | Reason |
|---|---|
| Read-only by construction | FMG client hardcodes JSON-RPC method `get`; FGT client only issues `GET`. |
| API only, no SSH/CLI | Structured JSON diffs cleanly. CLI-only FMG diagnostics are listed in the UI as unavailable. |
| Tokens live in environment variables | `devices.json` stores only the variable name, so it is safe to share and back up. `.env` is git-ignored. |
| Single shared login, standard library only | Enough to keep the page private on a lab network with no extra dependency or user database. PBKDF2 hash, HMAC-signed `HttpOnly` / `SameSite=Strict` cookie, `X-Requested-With` header on POSTs, per-IP throttle. Per-user accounts are out of scope. |
| Server-side result cache (default 5 min) | Clicking around must not poll the devices every time. Refresh is explicit (card, Refresh all, Shift+click, `?refresh=true`). Errors are never cached. |
| Health and snapshots always live | Health dots must show real reachability, and PRE/POST evidence must be real device state, not cached data. |
| Snapshots expire after 7 days | They contain full device state; `SNAPSHOT_TTL_HOURS` adjusts it. |
| Diff and verdicts in the browser | Works on uploaded files too; no server state needed to compare. |
| No build step for the front end | Plain HTML, CSS and JS served as static files. Per-check views live in `views.js`, chosen by check name, and fall back to the generic table for unknown checks. pytest runs `node --check` on both scripts and a render smoke test over sample data. |

## Runtime settings

Read from the process environment, or from a `.env` file next to `app.py` (real environment variables win).

| Variable | Default | Purpose |
|---|---|---|
| `DASH_PASSWORD_HASH` / `DASH_PASSWORD` | none (required) | dashboard login password (hash from `python app.py hash <pw>`; plain only for labs) |
| `DASH_USER` | `admin` | dashboard login name |
| `SESSION_SECRET` | random per start | signs login cookies; set it to keep logins across restarts |
| `SESSION_HOURS` | `8` | login lifetime |
| `CACHE_TTL_SECONDS` | `300` | result cache lifetime |
| `VERIFY_TLS` | `true` | `false` for lab self-signed certificates |
| `CA_BUNDLE` | none | custom CA file |
| `HTTP_TIMEOUT` | `8` | seconds before an unreachable device fails |
| `MAX_PARALLEL` | `8` | concurrent requests to devices |
| `SNAPSHOT_TTL_HOURS` | `168` | snapshot retention |
| `FMG_TOKEN`, `FGT_*_TOKEN` | none | API tokens, named in `devices.json` |

## Testing

`python -m pytest -q` runs the suite in `tests/` (login gate and lockout, cache hit/miss/refresh, errors not cached,
snapshot round trip and safe ids, `.env` loader, JavaScript syntax, per-check view rendering). Device calls are replaced by fakes, so no
FortiManager or FortiGate is needed.

## Not in scope today

Writes of any kind (config install, upgrades), multiple FMGs, per-user accounts or roles,
FortiGate access through the FMG proxy, and a database. Each would add or change a container above.
