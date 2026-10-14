# Fortinet Dashboard: C4 architecture

Read-only web tool for checking FortiManager (FMG) and FortiGate (FGT) before and after changes.
Diagrams are Mermaid and render in GitHub, GitLab and the VS Code Markdown preview.

## Level 1: System context

```mermaid
flowchart TB
    eng(["Network / security engineer<br/><i>runs checks, takes pre/post snapshots, reviews verdicts</i>"])
    dash["<b>Fortinet Dashboard</b><br/>Read-only checks, snapshots, diff and verdicts"]
    fmg[("FortiManager<br/><i>inventory, ADOMs, policy packages, sync status</i>")]
    fgt[("FortiGates<br/><i>live state: routes, BGP, IPsec, HA, interfaces</i>")]

    eng -- "HTTPS (browser)" --> dash
    dash -- "JSON-RPC over HTTPS<br/>method = get only" --> fmg
    dash -- "REST GET over HTTPS<br/>/api/v2/monitor, /cmdb" --> fgt
    fmg -. "manages" .-> fgt
```

## Level 2: Containers

```mermaid
flowchart TB
    eng(["Engineer"])

    subgraph dash ["Fortinet Dashboard (one Python process: uvicorn)"]
        spa["<b>Web page</b><br/>static/index.html<br/>vanilla JS, no build step<br/><i>UI, diff engine, verdict rules, exports</i>"]
        api["<b>API service</b><br/>app.py, FastAPI + httpx<br/><i>proxies read-only calls, health, cross-check, snapshot store</i>"]
        cfg[("<b>devices.json</b> + env vars<br/><i>hosts, token variable NAMES; tokens only in env</i>")]
        snaps[("<b>snapshots/</b> JSON files<br/><i>labelled pre/post, deleted after 24 h</i>")]
    end

    fmg[("FortiManager")]
    fgt[("FortiGates")]

    eng -- "browser" --> spa
    spa -- "fetch /api/*" --> api
    api -- "reads at startup" --> cfg
    api -- "read / write / purge" --> snaps
    api -- "JSON-RPC, Bearer token" --> fmg
    api -- "REST GET, Bearer token" --> fgt
```

Why the split: the browser never sees device tokens or talks to devices directly (TLS, CORS and
credentials stay on the server). The diff and verdict logic runs in the page so snapshots can also
be compared from uploaded files without a server round trip.

## Level 3: Components

### API service (app.py)

```mermaid
flowchart LR
    subgraph api ["API service"]
        cat["/api/catalog<br/><i>checks, devices, FMG server</i>"]
        chk["/api/fmg/{check}<br/>/api/fgt/{name}/{check}<br/><i>one read-only check</i>"]
        hl["/api/health<br/><i>reachable + auth per device</i>"]
        xc["/api/crosscheck<br/><i>FMG record vs FGT live, matched by serial</i>"]
        sn["/api/snapshots<br/><i>save, list, get; 24 h TTL purge</i>"]
        cl["Client layer<br/>fmg_get() / fgt_get()<br/><i>GET / 'get' only, shared httpx client,<br/>timeout + concurrency cap</i>"]
        cfgc["Config loader<br/><i>devices.json, env tokens</i>"]
    end
    chk --> cl
    hl --> cl
    xc --> cl
    cat --> cfgc
    cl --> cfgc
    cl --> ext["FortiManager / FortiGates"]
    sn --> disk[("snapshots/")]
```

### Web page (static/index.html)

```mermaid
flowchart LR
    subgraph spa ["Web page"]
        inv["Inventory panel<br/><i>FMG + FGT list, health dots</i>"]
        run["Check runner<br/><i>chips, Run all, ADOM / device scoping</i>"]
        view["Result renderer<br/><i>tables, JSON, filter, copy, download</i>"]
        col["Snapshot collector<br/><i>all checks → JSON file + server copy</i>"]
        cmp["Compare engine<br/><i>deep diff, ignores volatile fields</i>"]
        rul["Verdict rules<br/><i>BGP, IPsec, interfaces, routes, HA, FMG sync</i>"]
        exp["Exports<br/><i>HTML, CSV, JSON</i>"]
        xch["Cross-check view"]
    end
    inv --> run --> view
    col --> cmp --> rul --> exp
    xch
    run -. "/api/*" .-> api["API service"]
    col -. "/api/*" .-> api
    cmp -. "/api/snapshots" .-> api
    xch -. "/api/crosscheck" .-> api
```

## Key design decisions

| Decision | Reason |
|---|---|
| Read-only by construction | FMG client hardcodes JSON-RPC method `get`; FGT client only issues `GET`. |
| API only, no SSH/CLI | Structured JSON diffs cleanly. CLI-only FMG diagnostics are listed in the UI as unavailable. |
| Tokens live in environment variables | `devices.json` stores only the variable name, so it is safe to share and back up. |
| Snapshots expire after 24 h | They contain full device state; `SNAPSHOT_TTL_HOURS` adjusts it. |
| Diff and verdicts in the browser | Works on uploaded files too; no server state needed to compare. |

## Runtime settings

| Variable | Default | Purpose |
|---|---|---|
| `VERIFY_TLS` | `true` | `false` for lab self-signed certificates |
| `CA_BUNDLE` | none | custom CA file |
| `HTTP_TIMEOUT` | `8` | seconds before an unreachable device fails |
| `MAX_PARALLEL` | `8` | concurrent requests to devices |
| `SNAPSHOT_TTL_HOURS` | `24` | snapshot retention |
| `FMG_TOKEN`, `FGT_*_TOKEN` | none | API tokens, named in `devices.json` |

## Not in scope today

Writes of any kind (config install, upgrades), user login for the dashboard, multiple FMGs,
FortiGate access through the FMG proxy, and a database. Each would add or change a container above.
