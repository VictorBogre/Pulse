# Fortinet Dashboard

Read-only web tool for FortiManager (FMG) and FortiGate (FGT). Run checks, take **pre/post
snapshots**, and get a diff with **pass / warn / fail verdicts**. It never changes anything on a device.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the design.

## What it does

- **Checks**: FMG (system status, ADOMs, device list, inventory, device detail, device groups, policy packages,
  tasks, HA) and FGT (status, resources, HA, interfaces, routes, ARP, BGP, IPsec, SD-WAN, license, VDOMs).
  Each check is an icon tile; click it to run. The FMG `devices` check shows the same columns as
  `diagnose dvm device list`; use **device detail** for the full record.
- **VDOM dropdown** (FortiGate tab): filled automatically from the selected FortiGate; `root` (or your last choice) is
  pre-selected and used for every check, snapshot and session query.
- **Inventory panel**: FMG and FGT devices with a green/red reachability dot.
- **Snapshot PRE / POST**: two buttons in the command bar. Each runs every check for the selected device and
  downloads one JSON file; a copy is also saved on the server with the label `pre` or `post` and deleted after 7 days (`SNAPSHOT_TTL_HOURS`); the Compare picker shows the time left.
- **Compare snapshots**: pick two saved snapshots (or upload files). Shows a verdict, findings and every
  change. Export as HTML, CSV or JSON.
- **Login**: the dashboard is behind a single shared login page (see Quick start).
- **Result cache**: device results are cached on the server (5 minutes by default), so clicking around does not
  hit the devices every time. Cards show how old a result is. To get fresh data: **↻ Refresh** on a card (one check),
  **↻ Refresh all** (every check), Shift+click on a check tile, or **↻ Fetch live** in Sessions.
  **Run all** uses the cache; **Clear cache** (top right) empties it. The snapshot buttons always query live.
- **Readable views per check** (the JSON tab always has the raw data):
  - *Interfaces*: port tiles with an up/down LED, IP, speed, traffic and errors.
  - *Routes, BGP, ARP, IPsec*: summary tiles (route types and default route, neighbors established, tunnels up) above the table; status columns are colour pills; bytes, dates, speeds and durations are human readable.
  - *System status* (FortiGate and FortiManager): identity header with hostname, model, version and serial.
  - *HA, license, SD-WAN*: member cards, one tile per licensed service (unlicensed ones collapsed), and per-member health.
  - *FortiManager*: devices and inventory with a combined version column and connection / config / DB status pills, tasks with state and progress bars, device detail header.
  - Interface config and static routes show key columns only. Empty results say what it means (for example "Standalone: no HA peers").
- **Resources view**: the FortiGate `resources` check shows ring gauges for CPU, memory and disk (green / amber / red by load)
  and history charts with min / avg / max for sessions, new-session rate and log rate. Pick the history window (1 minute up
  to 24 hours) with the buttons or the dropdown; all charts follow it. The JSON tab still has the raw data.
- **Sessions** (FortiGate tab only): session table of the selected FortiGate, with a pass/warn/fail verdict shown as stat tiles (IPv4/IPv6 sessions, recent average, new sessions/s).

CLI-only FMG diagnostics (for example `diagnose dvm check-integrity`) have no API, so they are listed in the UI as unavailable.

## Requirements

- Python 3.10+ (Node.js is optional: only the JavaScript syntax test uses it)
- Network access from this machine to the devices over HTTPS
- A **read-only** API token for FortiManager and for each FortiGate (setup below)

## Quick start

```powershell
pip install -r requirements.txt
# 1. list your devices in devices.json (see below)
# 2. copy .env.example to .env and fill it in (the file is git-ignored; settings survive new PowerShell windows)
Copy-Item .env.example .env
python app.py hash "<your dashboard password>"      # prints salt$hash -> paste it as DASH_PASSWORD_HASH in .env
# 3. start
.\start.ps1                                         # same as: python -m uvicorn app:app --reload --no-access-log
```

Real environment variables (`$env:FMG_TOKEN="..."`) still work and take priority over `.env`. In PowerShell put a
hash in **single** quotes so the `$` is kept; inside `.env` no quotes are needed.

Open http://127.0.0.1:8000 and sign in (user `admin` unless `DASH_USER` is set). Use `python -m uvicorn` (not plain `uvicorn`) so it works even when
Python's Scripts folder is not on PATH. After updating the code, hard-refresh the page (Ctrl+F5) so the browser loads the new `app.js` / `app.css`.

## devices.json

```json
{
  "FMG-LAB-02": {"type": "fmg", "host": "192.168.0.200", "token_env": "FMG_TOKEN"},
  "FGT-LAB-01": {"type": "fgt", "host": "192.168.0.217", "token_env": "FGT_LAB_01_TOKEN"}
}
```

- `token_env` is the **name** of an environment variable, never the token itself. The file is
  therefore safe to share, but keep it out of public repositories anyway.
- `type` is optional. A name starting with `FMG` is treated as the FortiManager, anything else as a FortiGate.
- One FortiManager is supported. `FMG_HOST` and `FMG_TOKEN` environment variables also work if there is no entry.

## Creating the API users

**FortiGate**: *System > Administrators > Create New > REST API Admin*. Use a profile with
read-only access, and set **Trusted Hosts** to this machine's IP. Copy the token when it is shown.

**FortiManager**: *System Settings > Administrators > Create New*, user type **API user**, with a
read-only profile and access to the ADOMs you need. Generate the API key (token) and put this
machine in the trusted hosts. Bearer-token login needs a recent FortiManager (7.2.2 or later).

## Typical pre/post upgrade flow

1. Select the FortiGate in the Inventory panel, click **⬇ Snapshot PRE**.
2. Do the upgrade.
3. Click **⬇ Snapshot POST**.
4. Click **⇄ Compare**. The newest PRE and POST snapshots are pre-selected; click **Compare**.
5. Review the verdict, then **Export HTML** for the change ticket.

Verdict rules: BGP peers still Established, IPsec tunnels still up, no interface lost its link, route
count drop (warn at 2%, fail at 5%) and default route present, HA members unchanged, serial unchanged,
CPU/memory and session recovery, and FortiManager connection/sync state. A version change is shown as
information and does not change the verdict.

## Settings (environment variables)

| Variable | Default | Purpose |
|---|---|---|
| `VERIFY_TLS` | `true` | set to `false` for self-signed lab certificates |
| `CA_BUNDLE` | none | path to a custom CA file (preferred over disabling TLS checks) |
| `HTTP_TIMEOUT` | `8` | seconds before an unreachable device is reported as failed |
| `MAX_PARALLEL` | `8` | maximum concurrent requests to devices |
| `SNAPSHOT_TTL_HOURS` | `168` | how long saved snapshots are kept |
| `DASH_PASSWORD_HASH` | none | dashboard login password hash (create with `python app.py hash <password>`); required unless `DASH_PASSWORD` is set |
| `DASH_PASSWORD` | none | plain-text password, lab use only |
| `DASH_USER` | `admin` | dashboard login name |
| `SESSION_SECRET` | random | signs login cookies; set it to keep logins across restarts |
| `SESSION_HOURS` | `8` | login lifetime |
| `CACHE_TTL_SECONDS` | `300` | how long device results are cached; use the ↻ Refresh buttons to bypass |

## API

Interactive docs at http://127.0.0.1:8000/docs (after signing in). Any `GET` accepts `?refresh=true` to bypass the cache; responses carry `X-Cache: HIT|MISS` and `X-Cached-At`.

| Endpoint | Purpose |
|---|---|
| `POST /api/login`, `POST /api/logout` | sign in / out (every other endpoint needs the session cookie; POSTs also need header `X-Requested-With: dashboard`) |
| `POST /api/cache/clear` | empty the result cache |
| `GET /api/catalog` | available checks, devices, FortiManager |
| `GET /api/fmg/{check}?adom=&device=` | run one FortiManager check |
| `GET /api/fgt/{name}/{check}?vdom=` | run one FortiGate check |
| `GET /api/fgt/{name}/sessions`, `.../sessions/validate` | session table / session sanity check (`vdom`, `count`, `ip_version`) |
| `GET /api/health` | reachability and auth for every device (always live, never cached) |
| `POST /api/snapshots` | save a snapshot (`label` must be `pre` or `post`) |
| `GET /api/snapshots`, `GET /api/snapshots/{id}` | list (with hours until expiry) / fetch saved snapshots |

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| App exits with `Set DASH_PASSWORD_HASH` | set the dashboard password variable (Quick start) before starting |
| Locked out after failed logins | 5 wrong attempts block that IP for 5 minutes |
| Data looks stale | it is served from the cache; press **↻ Refresh** / **↻ Refresh all**, or lower `CACHE_TTL_SECONDS` |
| `uvicorn` is not recognized | use `python -m uvicorn app:app --reload` (or `.\start.ps1`) |
| Page is blank or a button does nothing after an update | hard-refresh (Ctrl+F5); if it persists, open the browser console (F12) and check for a script error |
| VDOM dropdown shows `default VDOM` | the FortiGate could not be reached when the list was loaded; pick the device again once it is reachable |
| `CERTIFICATE_VERIFY_FAILED` | device has a self-signed certificate: set `VERIFY_TLS=false` (lab) or `CA_BUNDLE` |
| `Env var ... is empty` | the token variable is missing from `.env` and from this PowerShell window, or `token_env` holds the token instead of a variable name |
| `ConnectTimeout` | wrong `host`, firewall, or the machine is not in the device's trusted hosts |
| `HTTP 401/403` | wrong token, or the API user lacks read access (or trusted-host mismatch) |
| `not_supported on this FortiOS version` | that endpoint does not exist on this FortiOS release; not an error in the tool |
| `FMG: No permission for the resource` (every FortiManager check fails, inventory empty) | the token logs in but its API user cannot read: in FortiManager give the user's admin profile **JSON API Access = Read**, Device Manager read access, and assign the ADOMs |
| Inventory panel empty on the FortiManager tab | the FortiManager is unreachable or the token is not set; hover the red dot for the reason |

## Security notes

- Read-only by construction: the FortiManager client always uses JSON-RPC method `get`, and the FortiGate client only issues `GET`.
- Tokens are read from the environment and are never sent to the browser, logged, or written into snapshots.
- The dashboard has a single shared login (`DASH_USER` / `DASH_PASSWORD_HASH`). Sessions use a signed `HttpOnly`, `SameSite=Strict` cookie; POST requests need the `X-Requested-With` header; 5 failed logins block that IP for 5 minutes. All pages, scripts and API calls except the login page need a session. Use HTTPS in front of it if exposed beyond localhost.
- `.env` holds tokens and the password hash: it is git-ignored, keep it that way.
- Snapshots hold full device state (routes, interfaces, VPN peers). They expire after 7 days by default, but downloaded copies do not, so store them accordingly.

## Tests

```powershell
pip install -r requirements-dev.txt
python -m pytest -q
```

No devices are needed; they are replaced by fakes. The suite covers the login gate, the result cache, snapshots, the
`.env` loader, JavaScript syntax, and a render test that feeds sample data to every per-check view (`tests/views_smoke.js`, needs Node.js).

## Project layout

```
app.py              FastAPI service (login, cache, API, device clients, snapshot store)
static/login.html   the sign-in page
static/index.html   the page shell; static/app.css (styles), static/views.js (per-check views, pills, units) and static/app.js (UI, diff, verdict rules)
devices.json        device list (hosts and token variable names)
.env                your settings and tokens (git-ignored; template: .env.example)
start.ps1           starts the server
tests/              automated tests: python -m pytest -q  (pip install -r requirements-dev.txt)
snapshots/          saved snapshots, auto-deleted after 7 days
ARCHITECTURE.md     C4 diagrams and design decisions
PLAN.MD             original scope and plan
```
