"""Run: python -m pytest -q   (from the project folder)"""
import os
import shutil
import subprocess
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

os.environ.setdefault("DASH_PASSWORD", "pw")
import app as A  # noqa: E402

ROOT = Path(A.__file__).parent
H = {"X-Requested-With": "dashboard"}


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(A, "SNAP_DIR", tmp_path / "snaps")
    monkeypatch.setattr(A, "FMG_HOST", "fmg")
    monkeypatch.setattr(A, "FMG_TOKEN", "t")
    A._cache.clear()
    A._fails.clear()
    with TestClient(A.app) as c:
        yield c


@pytest.fixture
def authed(client):
    assert client.post("/api/login", json={"username": A.DASH_USER, "password": "pw"}, headers=H).status_code == 200
    return client


def test_gate_blocks_anonymous(client):
    assert client.get("/api/catalog").status_code == 401
    r = client.get("/", follow_redirects=False)
    assert r.status_code == 307 and r.headers["location"] == "/login"
    r = client.get("/static/app.js", follow_redirects=False)
    assert r.status_code == 307 and r.headers["location"] == "/login"


def test_login_rules(client):
    assert client.post("/api/login", json={"username": "admin", "password": "no"}, headers=H).status_code == 401
    assert client.post("/api/login", json={"username": "admin", "password": "pw"}).status_code == 403  # no CSRF header
    for _ in range(5):
        client.post("/api/login", json={"username": "admin", "password": "no"}, headers=H)
    assert client.post("/api/login", json={"username": "admin", "password": "pw"}, headers=H).status_code == 429


def test_authed_access_and_logout(authed):
    assert authed.get("/api/catalog").status_code == 200
    assert authed.get("/static/app.js", follow_redirects=False).status_code == 200
    authed.post("/api/logout", headers=H)
    authed.cookies.clear()
    assert authed.get("/api/catalog").status_code == 401


def test_cache_hit_miss_refresh_and_errors_not_cached(authed, monkeypatch):
    calls = {"n": 0, "fail": False}

    async def fake(url, fields=None):
        calls["n"] += 1
        if calls["fail"]:
            raise A.HTTPException(502, "down")
        return [{"name": "root"}]

    monkeypatch.setattr(A, "_fmg_raw", fake)
    seen = [(authed.get("/api/fmg/adoms" + q).headers.get("x-cache"), calls["n"]) for q in ("", "", "?refresh=true", "")]
    assert seen == [("MISS", 1), ("HIT", 1), ("MISS", 2), ("HIT", 2)]
    A._cache.clear()
    calls["fail"] = True
    assert authed.get("/api/fmg/adoms").status_code == 502
    calls["fail"] = False
    assert authed.get("/api/fmg/adoms").headers.get("x-cache") == "MISS"  # the failure was not cached


def test_snapshot_roundtrip_and_safe_ids(authed):
    snap = {"source": "fortigate", "target": "FGT-1", "checks": {}}
    sid = authed.post("/api/snapshots", json={"label": "pre", "snapshot": snap}, headers=H).json()["id"]
    listed = authed.get("/api/snapshots").json()
    assert listed[0]["id"] == sid and listed[0]["label"] == "pre" and listed[0]["expires_in_h"] > 0
    assert authed.get(f"/api/snapshots/{sid}").json() == snap
    assert authed.get("/api/snapshots/..%5Capp").status_code == 404
    assert authed.post("/api/snapshots", json={"label": "other", "snapshot": snap}, headers=H).status_code == 422


def test_env_file_does_not_override_real_env(tmp_path, monkeypatch):
    f = tmp_path / ".env"
    f.write_text("# c\nA_ONE='x y'\nA_TWO=real$hash\nA_KEEP=file\n", encoding="utf-8")
    monkeypatch.delenv("A_ONE", raising=False)
    monkeypatch.delenv("A_TWO", raising=False)
    monkeypatch.setenv("A_KEEP", "env")
    A._load_env(f)
    assert (os.environ["A_ONE"], os.environ["A_TWO"], os.environ["A_KEEP"]) == ("x y", "real$hash", "env")
    for k in ("A_ONE", "A_TWO"):
        os.environ.pop(k, None)


@pytest.mark.skipif(not shutil.which("node"), reason="node not installed")
@pytest.mark.parametrize("name", ["app.js", "views.js"])
def test_frontend_js_syntax(name):
    r = subprocess.run(["node", "--check", str(ROOT / "static" / name)], capture_output=True, text=True)
    assert r.returncode == 0, r.stderr


@pytest.mark.skipif(not shutil.which("node"), reason="node not installed")
def test_views_render_sample_data():
    r = subprocess.run(["node", str(ROOT / "tests" / "views_smoke.js")], capture_output=True, text=True)
    assert r.returncode == 0, r.stdout + r.stderr


def test_page_loads_scripts_in_order(authed):
    html = authed.get("/").text
    assert html.index("/static/views.js") < html.index("/static/app.js")
    assert authed.get("/static/views.js", follow_redirects=False).status_code == 200
