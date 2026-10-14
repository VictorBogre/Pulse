"""Simple read-only FortiManager / FortiGate dashboard. Run: uvicorn app:app --reload"""
import asyncio
import base64
import contextvars
import hashlib
import hmac
import json
import logging
import os
import re
import secrets
import sys
import time
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal

import httpx
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

BASE = Path(__file__).parent


def _load_env(path: Path) -> None:
    """Read KEY=VALUE lines from .env so settings survive new PowerShell windows. Real env vars take priority."""
    if not path.is_file():
        return
    for line in path.read_text(encoding="utf-8-sig").splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            v = v.strip()
            if len(v) > 1 and v[0] == v[-1] and v[0] in "'\"":
                v = v[1:-1]
            os.environ.setdefault(k.strip(), v)


_load_env(BASE / ".env")
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
FMG_FIELDS = {"devices": ["name", "ip", "sn", "platform_str", "os_ver", "mr", "patch", "build",
                          "conn_status", "conf_status", "db_status", "ha_mode", "ha_group_name"],  # like 'diagnose dvm device list'
              "inventory": ["name", "hostname", "ip", "sn", "platform_str", "os_ver", "mr", "build", "patch",
                             "conn_status", "conf_status", "db_status", "dev_status", "ha_mode", "ha_group_name",
                             "vdom", "desc"]}
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


async def _fmg_raw(url: str, fields: list[str] | None = None) -> dict:
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
        msg = res["status"]["message"]
        if "permission" in msg.lower():
            msg += " (the API user's admin profile needs JSON API access = Read, Device Manager read access, and the ADOMs assigned)"
        raise HTTPException(502, f"FMG: {msg}")
    return res.get("data")


async def _fgt_raw(name: str, path: str, vdom: str | None, extra: dict | None = None) -> dict:
    dev = DEVICES.get(name)
    if not dev:
        raise HTTPException(404, f"Unknown device '{name}'")
    token = os.getenv(dev["token_env"], "")
    if not token:
        raise HTTPException(503, f"Env var {dev['token_env']} is empty (token_env must be the variable NAME, not the token)")
    params = {**({"vdom": vdom} if vdom else {}), **(extra or {})} or None
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

# ---- login (single shared account; signed session cookie, stdlib only) ----
# Set DASH_PASSWORD_HASH (python app.py hash <password>) or, for a lab, DASH_PASSWORD.
DASH_USER = os.getenv("DASH_USER", "admin")
_PW_HASH = os.getenv("DASH_PASSWORD_HASH", "")
_PW_PLAIN = os.getenv("DASH_PASSWORD", "")
SESSION_SECRET = (os.getenv("SESSION_SECRET") or secrets.token_hex(32)).encode()  # random => logins end on restart
SESSION_HOURS = float(os.getenv("SESSION_HOURS", "8"))
COOKIE = "fd_session"
PUBLIC = {"/login", "/api/login"}
_fails: dict[str, list[float]] = {}  # client ip -> recent failed-login times


def _hash_pw(pw: str, salt: str | None = None) -> str:
    salt = salt or secrets.token_hex(16)
    return f"{salt}${hashlib.pbkdf2_hmac('sha256', pw.encode(), salt.encode(), 200_000).hex()}"


def _check_pw(user: str, pw: str) -> bool:
    ok_user = hmac.compare_digest(user.encode(), DASH_USER.encode())
    if _PW_HASH:
        ok_pw = hmac.compare_digest(_hash_pw(pw, _PW_HASH.split("$")[0]), _PW_HASH)
    else:
        ok_pw = hmac.compare_digest(pw.encode(), _PW_PLAIN.encode())
    return ok_user and ok_pw


def _sign(msg: str) -> str:
    return hmac.new(SESSION_SECRET, msg.encode(), hashlib.sha256).hexdigest()


def _make_session() -> str:
    msg = base64.urlsafe_b64encode(f"{DASH_USER}|{int(time.time() + SESSION_HOURS * 3600)}".encode()).decode()
    return f"{msg}.{_sign(msg)}"


def _valid_session(tok: str | None) -> bool:
    try:
        msg, sig = (tok or "").rsplit(".", 1)
        user, exp = base64.urlsafe_b64decode(msg).decode().split("|")
        return hmac.compare_digest(sig, _sign(msg)) and user == DASH_USER and int(exp) > time.time()
    except ValueError:
        return False


if not (_PW_HASH or _PW_PLAIN) and __name__ != "__main__":
    raise RuntimeError("Set DASH_PASSWORD_HASH (python app.py hash <password>) or DASH_PASSWORD to enable the login")

# ---- cache: every FMG/FGT call is cached; ?refresh=true on any API request bypasses it ----
CACHE_TTL = float(os.getenv("CACHE_TTL_SECONDS", "300"))
log = logging.getLogger("uvicorn.error")  # shows up in the uvicorn console
_cache: dict[tuple, tuple[float, object]] = {}
_locks: dict[tuple, asyncio.Lock] = {}
_ctx: contextvars.ContextVar[dict | None] = contextvars.ContextVar("req_ctx", default=None)


async def _cached(key: tuple, fetch, use: bool = True):
    ctx = _ctx.get()
    if not use or ctx is None:
        return await fetch()
    async with _locks.setdefault(key, asyncio.Lock()):  # concurrent identical calls share one device request
        hit = _cache.get(key)
        if hit and not ctx["refresh"] and time.time() - hit[0] < CACHE_TTL:
            ctx["hits"] += 1
            ctx["oldest"] = min(ctx["oldest"] or hit[0], hit[0])
            return hit[1]
        log.info("DEVICE CALL %s", " ".join(str(k) for k in key if k))
        val = await fetch()  # errors raise here and are never cached
        if len(_cache) > 500:
            for k in [k for k, (t, _) in _cache.items() if time.time() - t >= CACHE_TTL]:
                _cache.pop(k, None)
        _cache[key] = (time.time(), val)
        ctx["misses"] += 1
        return val


async def fmg_get(url: str, fields: list[str] | None = None, use_cache: bool = True):
    return await _cached(("fmg", url, tuple(fields or ())), lambda: _fmg_raw(url, fields), use_cache)


async def fgt_get(name: str, path: str, vdom: str | None, extra: dict | None = None, use_cache: bool = True):
    return await _cached(("fgt", name, path, vdom, tuple(sorted((extra or {}).items()))),
                         lambda: _fgt_raw(name, path, vdom, extra), use_cache)


@app.middleware("http")
async def gate(request: Request, call_next):
    ctx = {"refresh": request.query_params.get("refresh") == "true", "hits": 0, "misses": 0, "oldest": None}
    _ctx.set(ctx)
    if request.url.path not in PUBLIC and not _valid_session(request.cookies.get(COOKIE)):
        if request.url.path.startswith("/api/") or request.method != "GET":
            return JSONResponse({"detail": "Not authenticated"}, 401)
        return RedirectResponse("/login")
    if request.method == "POST" and request.headers.get("x-requested-with") != "dashboard":
        return JSONResponse({"detail": "Missing X-Requested-With header"}, 403)  # CSRF guard
    resp = await call_next(request)
    if ctx["hits"] or ctx["misses"]:
        resp.headers["X-Cache"] = "MISS" if ctx["misses"] else "HIT"
        if not ctx["misses"]:
            resp.headers["X-Cached-At"] = str(int(ctx["oldest"]))
    return resp


@app.get("/login")
def login_page():
    return FileResponse(BASE / "static" / "login.html")


class LoginIn(BaseModel):
    username: str
    password: str


@app.post("/api/login")
def login(body: LoginIn, request: Request):
    ip = request.client.host if request.client else "?"
    recent = [t for t in _fails.get(ip, []) if time.time() - t < 300]
    if len(recent) >= 5:
        raise HTTPException(429, "Too many failed attempts, try again in a few minutes")
    if not _check_pw(body.username, body.password):
        _fails[ip] = recent + [time.time()]
        raise HTTPException(401, "Invalid username or password")
    _fails.pop(ip, None)
    resp = JSONResponse({"ok": True})
    resp.set_cookie(COOKIE, _make_session(), max_age=int(SESSION_HOURS * 3600), httponly=True,
                    samesite="strict", secure=request.url.scheme == "https")
    return resp


@app.post("/api/logout")
def logout():
    resp = JSONResponse({"ok": True})
    resp.delete_cookie(COOKIE)
    return resp


@app.post("/api/cache/clear")
def cache_clear():
    n = len(_cache)
    _cache.clear()
    return {"cleared": n}


app.mount("/static", StaticFiles(directory=BASE / "static"), name="static")


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
        probe(fmg_get("/sys/status", use_cache=False)) if FMG_HOST else asyncio.sleep(0, {"ok": False, "error": "not configured"}),
        *[probe(fgt_get(n, "monitor/system/status", None, use_cache=False)) for n in names])
    return {"fmg": results[0], "fgt": dict(zip(names, results[1:]))}


# ---- snapshots (stored locally in ./snapshots, never contain tokens) ----
SNAP_DIR = BASE / "snapshots"
_SAFE = re.compile(r"[^\w.-]+")
_SID = re.compile(r"^[\w.-]+$")


TTL_HOURS = float(os.getenv("SNAPSHOT_TTL_HOURS", "168"))  # saved snapshots are deleted after this long


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
                    "kb": p.stat().st_size // 1024,
                    "expires_in_h": max(0, round((p.stat().st_mtime + TTL_HOURS * 3600 - time.time()) / 3600, 1))})
    return out


@app.get("/api/snapshots/{sid}")
def snapshot_get(sid: str):
    _purge()
    p = SNAP_DIR / f"{sid}.json"
    if not _SID.match(sid) or not p.is_file():
        raise HTTPException(404, "Snapshot not found")
    return FileResponse(p, media_type="application/json")


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


@app.get("/api/fgt/{name}/sessions")
async def fgt_sessions(name: str, vdom: str | None = None, count: int = Query(1000, ge=1, le=20000),
                       ip_version: Literal["ipv4", "ipv6", "both"] = "ipv4"):
    """Session table entries (source/destination, policy, protocol, state, bytes...). Capped by `count`."""
    return await fgt_get(name, "monitor/firewall/session", vdom, {"count": count, "ip_version": ip_version})


@app.get("/api/fgt/{name}/sessions/validate")
async def fgt_sessions_validate(name: str, vdom: str | None = None, min_sessions: int = 1, drop_pct: float = 70):
    """Sanity-check the live session table: not empty, and not far below the recent average (traffic dropped?)."""
    res = (await fgt_get(name, FGT_CHECKS["resources"][1], vdom)).get("results") or {}
    findings, out = [], {}
    for key in ("session", "session6"):
        e = (res.get(key) or [{}])[0]
        cur = e.get("current")
        hist = e.get("historical") or {}
        avg = next((hist[k].get("average") for k in ("1-hour", "30-min", "10-min", "1-min")
                    if isinstance(hist.get(k), dict) and hist[k].get("average") is not None), None)
        out[key] = {"current": cur, "recent_average": avg}
        if cur is None:
            findings.append({"level": "warn", "msg": f"{key}: no data returned"})
        elif key == "session" and cur < min_sessions:
            findings.append({"level": "fail", "msg": f"{key}: {cur} sessions (expected at least {min_sessions})"})
        elif avg and cur < avg * drop_pct / 100:
            findings.append({"level": "warn", "msg": f"{key}: {cur} is below {drop_pct:g}% of recent average {avg}"})
    rate = (res.get("setup_rate") or [{}])[0].get("current")
    if rate is not None:
        out["setup_rate"] = rate
    levels = {f["level"] for f in findings}
    return {"device": name, "level": "fail" if "fail" in levels else "warn" if "warn" in levels else "pass",
            "sessions": out, "findings": findings}


@app.get("/api/fgt/{name}/{check}")
async def fgt_check(name: str, check: str, vdom: str | None = None):
    if check not in FGT_CHECKS:
        raise HTTPException(404, "Unknown FGT check")
    return await fgt_get(name, FGT_CHECKS[check][1], vdom)


if __name__ == "__main__" and sys.argv[1:2] == ["hash"] and len(sys.argv) == 3:
    print(_hash_pw(sys.argv[2]))
