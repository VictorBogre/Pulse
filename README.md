# Fortinet Dashboard

Read-only web tool for FortiManager (FMG) and FortiGate (FGT). Run checks, take **pre/post
snapshots**, and get a diff with **pass / warn / fail verdicts**. It never changes anything on a device.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the design.

## What it does

- **Checks**: FMG (system status, ADOMs, device inventory, device groups, policy packages, tasks, HA)
  and FGT (status, resources, HA, interfaces, routes, ARP, BGP, IPsec, SD-WAN, license, VDOMs).
- **Inventory panel**: FMG and FGT devices with a green/red reachability dot.
- **Collect snapshot**: runs every check for the selected device and downloads one JSON file. A copy is
  also saved on the server under the label `pre` or `post` and deleted after 24 hours.
- **Compare snapshots**: pick two saved snapshots (or upload files). Shows a verdict, findings and every
  change. Export as HTML, CSV or JSON.
- **Cross-check FMG ↔ FGT**: compares what FortiManager recorded (version, build, connection, sync) with what
  each FortiGate reports live, matched by serial number.

CLI-only FMG diagnostics (for example `diagnose dvm check-integrity`) have no API, so they are listed in the UI as unavailable.

## Requirements

- Python 3.10+
- Network access from this machine to the devices over HTTPS
- A **read-only** API token for FortiManager and for each FortiGate (setup below)

## Quick start

```powershell
pip install -r requirements.txt
# 1. list your devices in devices.json (see below)
# 2. set the tokens in this PowerShell window
$env:FMG_TOKEN="<fortimanager api token>"
$env:FGT_LAB_01_TOKEN="<fortigate api token>"
$env:VERIFY_TLS="false"          # only for lab devices with self-signed certificates
python -m uvicorn app:app --reload
```

Open http://127.0.0.1:8000. Use `python -m uvicorn` (not plain `uvicorn`) so it works even when
Python's Scripts folder is not on PATH. Environment variables last only for that PowerShell window.

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

1. Select the FortiGate in the Inventory panel, set the label to **pre**, click **⬇ Collect snapshot**.
2. Do the upgrade.
3. Set the label to **post**, click **⬇ Collect snapshot** again.
4. Click **⇄ Compare snapshots**, pick the pre and post snapshots, click **Compare**.
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
| `SNAPSHOT_TTL_HOURS` | `24` | how long saved snapshots are kept |

## API

Interactive docs at http://127.0.0.1:8000/docs.

| Endpoint | Purpose |
|---|---|
| `GET /api/catalog` | available checks, devices, FortiManager |
| `GET /api/fmg/{check}?adom=&device=` | run one FortiManager check |
| `GET /api/fgt/{name}/{check}?vdom=` | run one FortiGate check |
| `GET /api/health` | reachability and auth for every device |
| `GET /api/crosscheck` | FortiManager vs FortiGate comparison |
| `POST /api/snapshots` | save a snapshot (`label` must be `pre` or `post`) |
| `GET /api/snapshots`, `GET /api/snapshots/{id}` | list / fetch saved snapshots |

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `uvicorn` is not recognized | use `python -m uvicorn app:app --reload` |
| `CERTIFICATE_VERIFY_FAILED` | device has a self-signed certificate: set `VERIFY_TLS=false` (lab) or `CA_BUNDLE` |
| `Env var ... is empty` | the token variable is not set in this PowerShell window, or `token_env` holds the token instead of a variable name |
| `ConnectTimeout` | wrong `host`, firewall, or the machine is not in the device's trusted hosts |
| `HTTP 401/403` | wrong token, or the API user lacks read access (or trusted-host mismatch) |
| `not_supported on this FortiOS version` | that endpoint does not exist on this FortiOS release; not an error in the tool |
| Inventory panel empty on the FortiManager tab | the FortiManager is unreachable or the token is not set; hover the red dot for the reason |

## Security notes

- Read-only by construction: the FortiManager client always uses JSON-RPC method `get`, and the FortiGate client only issues `GET`.
- Tokens are read from the environment and are never sent to the browser, logged, or written into snapshots.
- The dashboard itself has **no login**. Run it on localhost (the default) or behind your own access control.
- Snapshots hold full device state (routes, interfaces, VPN peers). They expire after 24 hours, but downloaded copies do not, so store them accordingly.

## Project layout

```
app.py              FastAPI service (API, device clients, snapshot store)
static/index.html   the web page (UI, diff engine, verdict rules, exports)
devices.json        device list (hosts and token variable names)
snapshots/          saved snapshots, auto-deleted after 24 h
ARCHITECTURE.md     C4 diagrams and design decisions
PLAN.MD             original scope and plan
```
