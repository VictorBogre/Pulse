# Feature: NetOps Orchestrator — Fortinet Pre/Post Upgrade Platform (API-first)

> Status: DRAFT v0.3 (API-only) · Owner: <you> · Last updated: 2026-10-13
> Purpose of this doc: align on scope and architecture before writing code.
> Scope: **FortiGate (FortiOS REST API)** + **FortiManager (JSON-RPC API)**. No SSH/CLI.

---

## 1. Problem

Engineers upgrade FortiGate firmware using ad-hoc scripts, GUI screenshots and manual
CLI checks. Pre/post validation is inconsistent, HA and VPN state are checked by eye,
and FortiManager sync status is often forgotten after an upgrade, which leaves devices
out of sync or with failed installs later.

I have working prototypes (e.g. a `/snapshot` FastAPI endpoint using Netmiko/SSH),
but they are one-off scripts based on CLI text, not a platform.

**Why now:** upcoming FortiOS upgrade waves across many FortiGates and HA clusters;
we want repeatable, auditable checks using structured API data.

## 2. Goals / Success criteria

- An engineer can run **validate → pre-check → upgrade → post-check → diff report**
  for FortiGates (standalone or HA) through one API.
- **All data is collected via APIs**, from two sources:
  - **FortiGate REST API** → live operational state (HA, routes, VPN, SD-WAN, resources…)
  - **FortiManager JSON-RPC API** → inventory and management state (ADOMs, groups,
    firmware, connection/sync status, policy package & install status, revisions)
- The platform **cross-checks both sources** (e.g. FMG says 7.2.10, FGT reports 7.4.8
  → FMG inventory stale; FMG says "in sync" but device is unreachable → flag).
- Checks are **modules** (plugins). A new check = one new module.
- Every run is a **job** with ID, status, logs and stored results.
- Pre vs post gives a **structured JSON diff** with pass/warn/fail per check.

**Done for v1 =** demo: pull 10 lab FortiGates (incl. 1 HA pair) from FMG, run
pre-check, upgrade one manually, run post-check, get a report showing changed
IPsec tunnels / BGP peers / HA members / SD-WAN SLAs and the FMG sync/install status.

## 3. Non-goals (v1)

- ❌ SSH / CLI collection (no Netmiko, no screen scraping). If an API gap is found,
  it's documented and handled in v2, not patched with CLI.
- ❌ Performing the upgrade (image upload, install, reboot). v1 is read-only.
- ❌ Policy/object changes, config installs, "retrieve config" from FMG (write ops).
- ❌ Full web UI — API + OpenAPI docs only.
- ❌ FortiAnalyzer, FortiSwitch, FortiAP (v2 candidates).

## 4. Users & key flows

**Users:** network/security engineers (primary), change managers (reports),
later CI pipelines / ITSM integrations.

**Happy path:**
1. `POST /changes` → select devices from FMG (by ADOM, group, name, HA cluster,
   current version) + check profile + target version.
2. `POST /changes/{id}/validate` → API reachability (FGT + FMG), upgrade path,
   HA health, licenses, FMG sync before starting. Blocks the change on failures.
3. `POST /changes/{id}/pre` → collect snapshot from FGT API + FMG API.
4. Engineer upgrades (FMG firmware templates / GUI).
5. `POST /changes/{id}/post` → collect again.
6. `GET /changes/{id}/report` → diff per device per check + overall verdict.

**Edge cases:**
- **HA clusters:** one logical device; API queries go to the primary, HA member data
  from the HA API. Re-resolve primary before post-check (failover during upgrade).
- **VDOMs:** checks marked `per_vdom` call the API with `?vdom=<name>` for each VDOM.
- **No direct access to FGT** (mgmt network not reachable) → use FMG proxy
  (`/sys/proxy/json`) to call the same FortiOS endpoints through FMG.
- FGT unreachable in pre → `skipped`; unreachable in post → **critical**.
- **FMG and FGT disagree** (version, HA mode, serial) → `warn: source mismatch`.
- Check not applicable (no SD-WAN, no BGP) → `not_applicable`.
- Endpoint missing on that FortiOS version (HTTP 404) → `not_supported`, not a failure.
- Job cancelled → partial results kept.

## 5. Context & constraints

**Lessons from the prototype** (v1 must fix):
- Blocking SSH inside `async def` → replaced by async HTTP (`httpx.AsyncClient`).
- Sequential devices → concurrent with limits.
- Credentials in the request body → tokens from Vault/env, never in requests or logs.
- Raw CLI text → JSON from APIs, easy to diff.
- No per-device error handling → every device/check isolated.
- Blocking request → async jobs + polling.

**Data sources**

| | FortiGate REST API | FortiManager JSON-RPC API |
|---|---|---|
| Transport | HTTPS `GET /api/v2/monitor/...` and `/api/v2/cmdb/...` | HTTPS `POST /jsonrpc` |
| Auth | API admin token (`Authorization: Bearer`), trusted hosts | API user (session login or API key on supported versions) |
| Used for | live state: status, HA, interfaces, routes, BGP, IPsec, SD-WAN, resources, licenses | inventory, groups, HA members, firmware, conn/conf/db status, policy packages, install status, revisions |
| Access mode | direct, or via FMG proxy | direct |
| Access level | read-only admin profile | read-only API user |

**FortiGate endpoints (starting list — verify per FortiOS version):**
- `monitor/system/status` — hostname, serial, version, build
- `monitor/system/resource/usage` — CPU, memory, sessions
- `monitor/system/ha-peer`, `monitor/system/ha-checksums` — HA members & sync
- `monitor/system/interface` — link status, speed, counters
- `monitor/router/ipv4` — routing table
- `monitor/router/bgp/neighbors` (+ `bgp/paths` if needed) — BGP state
- `monitor/vpn/ipsec` — tunnels and phase2 selectors status
- `monitor/virtual-wan/health-check` — SD-WAN SLA status
- `monitor/license/status` — FortiCare/FortiGuard status
- `cmdb/system/vdom` — VDOM list

**FortiManager calls (starting list — verify per FMG version):**
- `/sys/login/user`, `/sys/logout` — session handling (if not using API key)
- `/dvmdb/adom` — ADOM list
- `/dvmdb/adom/{adom}/device` — devices: version, build, serial, HA, conn_status,
  conf_status, db_status
- `/dvmdb/adom/{adom}/group` — device groups
- `/pm/pkg/adom/{adom}` — policy packages and assignment/status
- device revision history (for "config revision changed after upgrade")
- `/task/task` — recent task status (failed installs/upgrades)
- `/sys/proxy/json` — proxy FortiOS API calls to managed FGTs

**Tech stack:**
- Python 3.12, FastAPI, Pydantic v2
- `httpx` async clients for both APIs (optional `pyFMG` reference for FMG)
- Jobs: ARQ/Celery + Redis (or BackgroundTasks for M1, see Q1)
- Storage: PostgreSQL (results as JSONB); SQLite for dev
- Secrets: Vault / env vars
- Docker Compose (api, worker, redis, postgres)

**Constraints:**
- Read-only: only `GET` on FortiOS; only `get` method on FMG JSON-RPC (plus login/proxy).
  Enforced in the client classes, not just by convention.
- Orchestrator IPs must be in FGT API admin **trusted hosts**.
- FMG: reuse one session per worker, respect API session limits, throttle proxy calls.
- TLS verification on by default; custom CA bundle supported.
- Versions in scope: FortiOS 7.0–7.6, FortiManager 7.2+.

## 6. Proposed architecture

```
                ┌──────────────────────────┐
  Engineer ───► │  FastAPI (API layer)     │  /changes /jobs /devices /modules
   / CI         └──────────┬───────────────┘
                           │ enqueue job
                ┌──────────▼───────────────┐
                │  Orchestrator (core)     │  inventory, HA/VDOM resolution,
                │                          │  profile, fan-out, cross-checks
                └───┬──────────────────┬───┘
                    │                  │
         ┌──────────▼───────┐   ┌──────▼──────────────┐
         │ FortiGate client │   │ FortiManager client │
         │ (REST, token)    │   │ (JSON-RPC, session) │
         └───┬──────────┬───┘   └──────┬──────────────┘
      direct │          │ via proxy    │
             ▼          └──────────────┤
        FortiGates  ◄──────────────────┘ /sys/proxy/json
             
   Workers run modules → results → PostgreSQL → Diff engine → Report (JSON)
```

**Client layer:**

```python
class FortiGateAPI(Protocol):
    """Same interface whether direct or via FMG proxy."""
    async def get(self, path: str, vdom: str | None = None,
                  params: dict | None = None) -> dict: ...

class DirectFortiGateAPI:      # httpx -> https://<fgt>/api/v2/<path>
class FMGProxyFortiGateAPI:    # FMG /sys/proxy/json -> same <path> on target FGT

class FortiManagerAPI:
    async def get(self, url: str, **params) -> dict: ...   # JSON-RPC "get"
    async def devices(self, adom: str) -> list[FMGDevice]: ...
    async def proxy(self, device: str, path: str) -> dict: ...
```

Device access mode (`direct` | `fmg_proxy`) is set per device/site in inventory,
with automatic fallback to proxy if direct fails (configurable).

**Module contract:**

```python
class CheckModule(Protocol):
    name: str
    source: Literal["fortigate", "fortimanager", "both"]
    per_vdom: bool
    min_fortios: str | None
    expect: Literal["identical", "change", "threshold"]

    async def collect(self, ctx: CheckContext) -> dict:
        """ctx gives ctx.fgt (FortiGateAPI), ctx.fmg (FortiManagerAPI), device, vdom."""

    def compare(self, pre: dict, post: dict, cfg: dict) -> CheckResult: ...
```

**Check modules (v1):**

| Module | Source | Compare logic |
|---|---|---|
| `system_status` | FGT | version/build equals target; serial unchanged |
| `ha_status` | FGT | same members, all same version, checksums match |
| `resources` | FGT | CPU/mem below threshold, not in conserve mode |
| `interfaces` | FGT | no new down interfaces |
| `routing` | FGT, per VDOM | route count per protocol within threshold, default route present |
| `bgp` | FGT, per VDOM | same peers established, prefix counts within threshold |
| `ipsec` | FGT, per VDOM | same tunnels/phase2 up |
| `sdwan` | FGT, per VDOM | SLA members still in SLA |
| `sessions` | FGT | session count recovered to ≥ X% of pre |
| `license` | FGT | FortiCare/FortiGuard valid |
| `fmg_device_state` | FMG | connected, config in sync, DB not modified |
| `fmg_policy_package` | FMG | package status unchanged / not "out of sync" |
| `fmg_tasks` | FMG | no failed tasks for the device during the window |
| `source_consistency` | both | FMG version/serial/HA mode match FGT live data |
| `upgrade_path` | FGT + data file | target reachable via supported hops (validate only) |

**Example profile:**

```yaml
name: fortigate-branch-sdwan
target_version: "7.4.8"      # example
access_mode: direct           # or fmg_proxy
modules:
  - system_status
  - ha_status
  - resources: { cpu_max_pct: 80, mem_max_pct: 85 }
  - interfaces
  - routing: { route_drop_warn_pct: 2, route_drop_fail_pct: 5 }
  - ipsec
  - sdwan
  - sessions: { recover_min_pct: 70 }
  - license
  - fmg_device_state
  - fmg_policy_package
  - fmg_tasks
  - source_consistency
```

**Repository layout:**
```
netops/
  api/            # FastAPI routers, schemas
  core/           # orchestrator, jobs, diff engine, HA/VDOM resolution
  clients/        # fortigate.py (direct + proxy), fortimanager.py
  inventory/      # fmg inventory provider, yaml provider
  modules/        # check modules
  profiles/       # YAML profiles
  data/           # fortios_upgrade_paths.yaml
  storage/        # DB models
tests/
  fixtures/       # recorded FGT REST + FMG JSON-RPC responses per version
```

**API sketch:**
| Method | Path | Purpose |
|---|---|---|
| GET  | /devices | FGTs from FMG (filter: ADOM, group, version, HA) |
| GET  | /devices/{name}/live | quick live status from FGT API |
| GET  | /modules | available check modules |
| POST | /changes | create change |
| POST | /changes/{id}/validate | pre-flight checks |
| POST | /changes/{id}/pre | pre-check job |
| POST | /changes/{id}/post | post-check job |
| GET  | /jobs/{id} | job status, progress, logs |
| GET  | /changes/{id}/report | pre/post diff |
| POST | /snapshot | ad-hoc snapshot (API-based replacement of prototype) |

## 7. Open questions

- [ ] **Q1** Job runner: BackgroundTasks for M1, or ARQ/Celery + Redis from day one?
- [ ] **Q2** Default access mode: direct to FGT (tokens on every device) or FMG proxy
      everywhere? Proposal: **direct by default, proxy as fallback**.
- [ ] **Q3** FGT tokens: one API admin per device or shared? Rotation process?
- [ ] **Q4** FMG auth: session login or API key (depends on FMG version)?
- [ ] **Q5** Single FMG or multiple? How many ADOMs?
- [ ] **Q6** VDOMs in use? Which ones?
- [ ] **Q7** Thresholds per profile or per device group?
- [ ] **Q8** Report output: JSON only, or HTML/PDF for change tickets?
- [ ] **Q9** v2: drive upgrades through FMG API? If yes, define write permissions + approvals.

## 8. Risks

- **API fields/endpoints differ across FortiOS/FMG versions** → recorded fixtures per
  version; `not_supported` status on 404; schema-tolerant parsing.
- **API coverage gaps** (data only available in CLI) → listed explicitly; decide in v2.
- **FMG overload** from proxy fan-out → throttle, prefer direct.
- **Token / trusted-host misconfiguration** → caught by `validate` before the window.
- **HA failover during upgrade** → re-resolve primary before post.
- **FMG data stale** vs device → `source_consistency` check makes it visible.

## 9. Milestones

1. **M1 – Skeleton + FGT client:** FastAPI app, Docker Compose, YAML inventory,
   async FortiGate REST client (read-only enforced), `/snapshot` via API.
2. **M2 – FMG client:** JSON-RPC client, FMG inventory (ADOMs, groups, HA),
   FMG proxy client implementing the same `FortiGateAPI` interface.
3. **M3 – Jobs & storage:** job model, workers, Postgres, `/jobs/{id}`.
4. **M4 – Modules:** contract + `system_status`, `ha_status`, `resources`, `interfaces`,
   `routing`, `ipsec`, `fmg_device_state`.
5. **M5 – Pre/Post & diff:** `/changes` flow, diff engine, `source_consistency`, report.
6. **M6 – Hardening:** `validate` + `upgrade_path`, `bgp`, `sdwan`, `sessions`, `license`,
   `fmg_policy_package`, `fmg_tasks`, VDOMs, Vault, concurrency limits, API auth.
7. **M7 (v2):** HTML report, UI, FMG-driven upgrades, FortiSwitch/FortiAP, ITSM.

## 10. Acceptance checklist (v1)

- [ ] No SSH anywhere; all data from FGT REST or FMG JSON-RPC
- [ ] Read-only enforced in clients (non-GET / non-"get" calls rejected)
- [ ] Inventory from FMG (ADOM + HA members)
- [ ] Same check works direct and via FMG proxy
- [ ] Pre/post end to end on 10+ lab FGTs incl. 1 HA pair
- [ ] FMG vs FGT mismatches reported
- [ ] One unreachable device doesn't fail the job
- [ ] No tokens/passwords in requests, logs or stored results
- [ ] Module tests with recorded FGT + FMG fixtures
- [ ] OpenAPI docs + README (setup FMG user, FGT API admin, write a module)