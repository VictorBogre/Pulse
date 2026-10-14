"""Simple read-only FortiManager / FortiGate dashboard. Run: uvicorn app:app --reload"""
import asyncio
import json
import os
import re
import time
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel

BASE = Path(__file__).parent
VERIFY = os.getenv("VERIFY_TLS", "true").lower() != "false"
CA = os.getenv("CA_BUNDLE")  # optional custom CA bundle

# devices.json -> {"name": {"type": "fmg"|"fgt", "host": "...", "token_env": "ENV_VAR_NAME"}}
# "type" is optional: names starting with FMG are treated as FortiManager, everything else as FortiGate.
# Env FMG_HOST / FMG_TOKEN still work as a fallback for the FortiManager.
DEVICES = json.loads((BASE / "devices.json").read_text()) if (BASE / "devices.json").exists() else {}
_type = lambda k, v: v.get("type") or ("fmg" if k.upper().startswith("FMG") else "fgt")
_fmg_key = next((k for k, v in DEVICES.items() if _type(k, v) == "fmg"), None)
_fmg = DEVICES.pop(_fmg_key, {}) if _fmg_key else {}
DEVICES = {k: v for k, v in DEVICES.items() if _type(k, v) == "fgt"}
FMG_HOST = _fmg.get("host") or os.getenv("FMG_HOST", "")
FMG_TOKEN = os.getenv(_fmg.get("token_env", "FMG_TOKEN"), "")

# check name -> (description, FMG JSON-RPC url | FGT REST path). {adom}/{device} are filled from the query.
FMG_CHECKS = {
    "system_status":   ("get system status", "/sys/status"),
    "ha_status":       ("diagnose ha status (API: ha config)", "/cli/global/system/ha"),
    "adoms":           ("ADOM list", "/dvmdb/adom"),
    "devices":         ("diagnose dvm device list", "/dvmdb/adom/{adom}/device"),
    "inventory":       ("device inventory (name, IP, version, status)", "/dvmdb/adom/{adom}/device"),
    "device_detail":   ("selected device: full FMG record", "/dvmdb/adom/{adom}/device/{device}"),
    "device_vdoms":    ("selected device: VDOMs", "/dvmdb/adom/{adom}/device/{device}/vdom"),
    "device_groups": ("device groups", "/dvmdb/adom/{adom}/group"),
    "policy_packages": ("policy packages (API: pm/pkg)", "/pm/pkg/adom/{adom}"),
    "tasks":           ("recent tasks", "/task/task"),
}
# No JSON-RPC/REST equivalent exists - these are CLI only (SSH), out of scope for an API-only tool.
FMG_FIELDS = {"inventory": ["name", "hostname", "ip", "sn", "platform_str", "os_ver", "mr", "build", "patch",
                             "conn_status", "conf_status", "db_status", "dev_status", "ha_mode", "ha_group_name",
                             "vdom", "desc"],
              "crosscheck": ["name", "hostname", "ip", "sn", "os_ver", "mr", "patch", "build",
                             "conn_status", "conf_status", "db_status", "ha_mode"]}
FMG_CLI_ONLY = [
    "diagnose cdb check objcfg-integrity",
    "diagnose cdb check policy-packages {adom}",
    "diagnose dvm check-integrity",
    "diagnose system print df",
]
FGT_CHECKS = {
    "system_status": ("get system status", "monitor/system/status"),
    "resources":     ("CPU / memory / sessions", "monitor/system/resource/usage"),
    "ha_peers":      ("HA members", "monitor/system/ha-peer"),
    "ha_checksums":  ("HA checksums", "monitor/system/ha-checksums"),
    "interfaces":    ("interface status/counters", "monitor/system/interface"),
    "interface_cfg": ("interface config", "cmdb/system/interface"),
    "routes":        ("routing table", "monitor/router/ipv4"),
    "static_routes": ("static route config", "cmdb/router/static"),
    "arp":           ("ARP table", "monitor/network/arp"),
    "bgp":           ("BGP neighbors", "monitor/router/bgp/neighbors"),
    "ipsec":         ("IPsec tunnels", "monitor/vpn/ipsec"),
    "sdwan":         ("SD-WAN health checks", "monitor/virtual-wan/health-check"),
    "license":       ("FortiCare / FortiGuard", "monitor/license/status"),
    "vdoms":         ("VDOM list", "cmdb/system/vdom"),
}

TIMEOUT = float(os.getenv("HTTP_TIMEOUT", "8"))  # seconds; unreachable devices fail fast
MAX_PARALLEL = int(os.getenv("MAX_PARALLEL", "8"))  # cap on concurrent device/FMG requests
_http: httpx.AsyncClient
_slots = asyncio.Semaphore(MAX_PARALLEL)


@asynccontextmanager
async def lifespan(_):
    global _http
    _purge()  # clean up expired snapshots at startup
    _http = httpx.AsyncClient(verify=CA or VERIFY, timeout=TIMEOUT)  # one pooled client for all calls
    yield
    await _http.aclose()


app = FastAPI(title="Fortinet Read-Only Dashboard", lifespan=lifespan)


async def fmg_get(url: str, fields: list[str] | None = None) -> dict:
    if not (FMG_HOST and FMG_TOKEN):
        raise HTTPException(503, "Set FMG_HOST and FMG_TOKEN")
    params = {"url": url, **({"fields": fields} if fields else {})}
    body = {"id": 1, "method": "get", "params": [params]}  # read-only: method is hardcoded
    async with _slots:
        try:
            r = await _http.post(f"https://{FMG_HOST}/jsonrpc", json=body,
                                 headers={"Authorization": f"Bearer {FMG_TOKEN}"})
            r.raise_for_status()
        except httpx.HTTPError as e:
            raise HTTPException(502, f"FMG {FMG_HOST}: {type(e).__name__} {e}")
    res = r.json()["result"][0]
    if res["status"]["code"] != 0:
        raise HTTPException(502, f"FMG: {res['status']['message']}")
    return res.get("data")


async def fgt_get(name: str, path: str, vdom: str | None) -> dict:
    dev = DEVICES.get(name)
    if not dev:
        raise HTTPException(404, f"Unknown device '{name}'")
    token = os.getenv(dev["token_env"], "")
    if not token:
        raise HTTPException(503, f"Env var {dev['token_env']} is empty (token_env must be the variable NAME, not the token)")
    params = {"vdom": vdom} if vdom else None
    async with _slots:  # GET only
        try:
            r = await _http.get(f"https://{dev['host']}/api/v2/{path}", params=params,
                                headers={"Authorization": f"Bearer {token}"})
        except httpx.HTTPError as e:
            raise HTTPException(502, f"FGT {name}: {type(e).__name__} {e}")
    if r.status_code == 404:
        raise HTTPException(404, "not_supported on this FortiOS version")
    if r.status_code >= 400:
        raise HTTPException(502, f"FGT {name}: HTTP {r.status_code}")
    return r.json()


@app.get("/")
def index():
    return FileResponse(BASE / "static" / "index.html")


@app.get("/api/catalog")
def catalog():
    return {
        "fmg": {k: v[0] for k, v in FMG_CHECKS.items()},
        "fmg_cli_only": FMG_CLI_ONLY,
        "fmg_device_scoped": [k for k, v in FMG_CHECKS.items() if "{device}" in v[1]],
        "fmg_adom_scoped": [k for k, v in FMG_CHECKS.items() if "{adom}" in v[1]],
        "fgt": {k: v[0] for k, v in FGT_CHECKS.items()},
        "devices": list(DEVICES),
        "device_hosts": {k: v["host"] for k, v in DEVICES.items()},
        "fmg_server": {"name": _fmg_key or "FortiManager", "host": FMG_HOST} if FMG_HOST else None,
        "fmg_configured": bool(FMG_HOST and FMG_TOKEN),
    }


@app.get("/api/health")
async def health():
    """Reachability + auth for the FortiManager and every FortiGate."""
    async def probe(coro):
        try:
            await coro
            return {"ok": True}
        except HTTPException as e:
            return {"ok": False, "error": e.detail}
    names = list(DEVICES)
    results = await asyncio.gather(
        probe(fmg_get("/sys/status")) if FMG_HOST else asyncio.sleep(0, {"ok": False, "error": "not configured"}),
        *[probe(fgt_get(n, "monitor/system/status", None)) for n in names])
    return {"fmg": results[0], "fgt": dict(zip(names, results[1:]))}


# ---- snapshots (stored locally in ./snapshots, never contain tokens) ----
SNAP_DIR = BASE / "snapshots"
_SAFE = re.compile(r"[^\w.-]+")
_SID = re.compile(r"^[\w.-]+$")


TTL_HOURS = float(os.getenv("SNAPSHOT_TTL_HOURS", "24"))  # saved snapshots are deleted after this long


def _purge():
    """Delete snapshots older than the TTL (by file modification time)."""
    if not SNAP_DIR.exists():
        return
    cutoff = time.time() - TTL_HOURS * 3600
    for p in SNAP_DIR.glob("*.json"):
        try:
            if p.stat().st_mtime < cutoff:
                p.unlink()
        except OSError:
            pass  # in use / already gone: retry on the next call


class SnapshotIn(BaseModel):
    label: Literal["pre", "post"]
    snapshot: dict


@app.post("/api/snapshots")
def snapshot_save(body: SnapshotIn):
    _purge()
    SNAP_DIR.mkdir(exist_ok=True)
    s = body.snapshot
    ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    parts = (ts, body.label or "snapshot", str(s.get("source", "")), str(s.get("target", "")))
    sid = "__".join(_SAFE.sub("_", p)[:60] or "x" for p in parts)
    (SNAP_DIR / f"{sid}.json").write_text(json.dumps(s))
    return {"id": sid}


@app.get("/api/snapshots")
def snapshot_list():
    _purge()
    files = sorted(SNAP_DIR.glob("*.json"), reverse=True) if SNAP_DIR.exists() else []
    out = []
    for p in files:
        ts, label, source, target = (p.stem.split("__") + ["", "", "", ""])[:4]
        out.append({"id": p.stem, "time": ts, "label": label, "source": source, "target": target,
                    "kb": p.stat().st_size // 1024})
    return out


@app.get("/api/snapshots/{sid}")
def snapshot_get(sid: str):
    _purge()
    p = SNAP_DIR / f"{sid}.json"
    if not _SID.match(sid) or not p.is_file():
        raise HTTPException(404, "Snapshot not found")
    return FileResponse(p, media_type="application/json")


# ---- cross-check: what FortiManager has recorded vs what each FortiGate reports live ----
def _enum(v, names):
    return str(v).lower().replace(" ", "") if isinstance(v, str) else names.get(v, "unknown")


def _fmg_version(d):
    try:
        return f"{int(float(str(d.get('os_ver'))))}.{d.get('mr')}.{d.get('patch')}"
    except (TypeError, ValueError):
        return ""


@app.get("/api/crosscheck")
async def crosscheck():
    names = list(DEVICES)

    async def live(n):
        try:
            return await fgt_get(n, "monitor/system/status", None)
        except HTTPException as e:
            return {"error": e.detail}

    fmg_err, fmg_devs = None, []
    try:
        fmg_devs = await fmg_get("/dvmdb/device", FMG_FIELDS["crosscheck"]) or []
    except HTTPException as e:
        fmg_err = e.detail
    fgts = await asyncio.gather(*[live(n) for n in names])
    by_sn = {str(d.get("sn", "")).lower(): d for d in fmg_devs if d.get("sn")}
    rows = []
    for n, st in zip(names, fgts):
        row = {"device": n, "host": DEVICES[n]["host"], "fgt": None, "fmg": None, "findings": []}
        add = lambda level, msg: row["findings"].append({"level": level, "msg": msg})
        if "error" in st:
            add("fail", f"FortiGate unreachable: {st['error']}")
        else:
            ver = str(st.get("version", "")).lstrip("v")
            row["fgt"] = {"hostname": (st.get("results") or {}).get("hostname"), "serial": st.get("serial"),
                          "version": ver, "build": st.get("build")}
            m = by_sn.get(str(st.get("serial", "")).lower())
            if fmg_err:
                add("warn", f"FortiManager unavailable: {fmg_err}")
            elif not m:
                add("warn", "Serial not found in FortiManager (not managed, or different FMG)")
            else:
                conn = _enum(m.get("conn_status"), {1: "up", 2: "down"})
                conf = _enum(m.get("conf_status"), {1: "insync", 2: "outofsync"})
                db = _enum(m.get("db_status"), {1: "nomod", 2: "modified"})
                row["fmg"] = {"name": m.get("name"), "version": _fmg_version(m), "build": m.get("build"),
                              "conn_status": conn, "conf_status": conf, "db_status": db}
                if row["fmg"]["version"] and row["fmg"]["version"] != ver:
                    add("warn", f"Version mismatch: FortiManager {row['fmg']['version']} vs FortiGate {ver} (FMG inventory stale?)")
                if m.get("build") and st.get("build") and int(m["build"]) != int(st["build"]):
                    add("warn", f"Build mismatch: FortiManager {m['build']} vs FortiGate {st['build']}")
                if conn != "up":
                    add("fail", f"FortiManager connection status is {conn}")
                if conf != "insync":
                    add("warn", f"FortiManager config status is {conf}")
                if db.startswith("mod"):
                    add("warn", "Device DB modified on FortiManager (unsaved/unretrieved changes)")
                if m.get("hostname") and row["fgt"]["hostname"] and m["hostname"] != row["fgt"]["hostname"]:
                    add("info", f"Hostname differs: FMG {m['hostname']} vs FGT {row['fgt']['hostname']}")
        levels = [f["level"] for f in row["findings"]]
        row["level"] = "fail" if "fail" in levels else "warn" if "warn" in levels else "pass"
        rows.append(row)
    return {"fmg_error": fmg_err, "rows": rows}


@app.get("/api/fmg/{check}")
async def fmg_check(check: str, adom: str = "root", device: str = ""):
    if check not in FMG_CHECKS:
        raise HTTPException(404, "Unknown FMG check")
    url = FMG_CHECKS[check][1]
    if "{device}" in url and not device:
        raise HTTPException(400, "This check needs a device")
    if device and check in ("devices", "inventory"):  # narrow the list to the selected device
        url += "/{device}"
    return await fmg_get(url.format(adom=adom, device=device), FMG_FIELDS.get(check))


@app.get("/api/fgt/{name}/{check}")
async def fgt_check(name: str, check: str, vdom: str | None = None):
    if check not in FGT_CHECKS:
        raise HTTPException(404, "Unknown FGT check")
    return await fgt_get(name, FGT_CHECKS[check][1], vdom)
