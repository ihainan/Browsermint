#!/usr/bin/env python3
"""
Browsermint E2E Test Script

Usage:
  python3 test_e2e.py [--base-url URL] [--email EMAIL] [--password PASS]

Steps:
  1. Verify / bring up docker compose services
  2. Register or login test user
  3. Create or reuse a running session
  4. Run comprehensive tests: HTTP proxy APIs, WebSocket (CDP, cast, logs, pageId)
  5. Verify custom features: stealth, passkey override, session events
"""

import argparse
import asyncio
import json
import secrets
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

import requests
import websockets
from websockets.asyncio.client import ClientConnection

# ─── Configuration ─────────────────────────────────────────────────────────────

DOCKER_DIR = Path(__file__).parent / "docker"

DEFAULT_BASE_URL = "http://localhost:24700"
DEFAULT_EMAIL    = "test_e2e@browsermint.local"
DEFAULT_USERNAME = "test_e2e"
DEFAULT_PASSWORD = "TestE2EPass123!"
DEFAULT_SESSION_NAME = "Browsermint E2E Smoke"

SESSION_READY_TIMEOUT = 60   # seconds to wait for a session to reach "running"
SESSION_WAIT_POLL     = 2    # poll interval

# ─── Terminal Helpers ──────────────────────────────────────────────────────────

GREEN  = "\033[32m"
RED    = "\033[31m"
YELLOW = "\033[33m"
CYAN   = "\033[36m"
RESET  = "\033[0m"
BOLD   = "\033[1m"

_passed = 0
_failed = 0

def section(title: str) -> None:
    print(f"\n{BOLD}{CYAN}{'─' * 60}{RESET}", flush=True)
    print(f"{BOLD}{CYAN}  {title}{RESET}", flush=True)
    print(f"{BOLD}{CYAN}{'─' * 60}{RESET}", flush=True)

def ok(name: str, detail: str = "") -> None:
    global _passed
    _passed += 1
    suffix = f"  {YELLOW}{detail}{RESET}" if detail else ""
    print(f"  {GREEN}✓{RESET} {name}{suffix}", flush=True)

def fail(name: str, detail: str = "") -> None:
    global _failed
    _failed += 1
    suffix = f"  {RED}{detail}{RESET}" if detail else ""
    print(f"  {RED}✗{RESET} {name}{suffix}", flush=True)

def info(msg: str) -> None:
    print(f"  {YELLOW}→{RESET} {msg}", flush=True)

def fatal(msg: str) -> None:
    print(f"\n{RED}{BOLD}FATAL: {msg}{RESET}\n", flush=True)
    _print_summary()
    sys.exit(1)

def _print_summary() -> None:
    total = _passed + _failed
    color = GREEN if _failed == 0 else RED
    print(f"\n{BOLD}{'─' * 60}{RESET}", flush=True)
    print(f"{color}{BOLD}Results: {_passed}/{total} passed, {_failed} failed{RESET}", flush=True)

# ─── Docker Helpers ────────────────────────────────────────────────────────────

def run(cmd: list[str], cwd: Path | None = None, check: bool = True) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True, text=True, cwd=cwd, check=check)

def docker_compose(*args: str) -> subprocess.CompletedProcess:
    return run(["docker", "compose", *args], cwd=DOCKER_DIR, check=False)

def ensure_env_file() -> None:
    """Create docker/.env from example and fill safe local E2E defaults."""
    env_file     = DOCKER_DIR / ".env"
    example_file = DOCKER_DIR / ".env.example"
    if not env_file.exists():
        if not example_file.exists():
            fatal(".env and .env.example both missing in docker/")
        info(".env not found — creating local E2E defaults from .env.example")
        env_file.write_text(example_file.read_text())

    values = _parse_env_file(env_file)
    changed = False

    defaults = {
        "NGINX_PORT": "24700",
        "POSTGRES_USER": "browsermint",
        "POSTGRES_PASSWORD": f"browsermint_e2e_{secrets.token_hex(12)}",
        "POSTGRES_DB": "browsermint",
        "POSTGRES_DATA_DIR": str((DOCKER_DIR / "postgres-data").resolve()),
        "JWT_SECRET": secrets.token_hex(32),
        "JWT_SESSION_TOKEN_SECRET": secrets.token_hex(32),
        "STEEL_BROWSER_IMAGE": "ihainan/browsermint-browser:0.5.1",
        # The E2E script talks to nginx over http://localhost, so Secure cookies
        # would be stored but not sent by requests.Session.
        "COOKIE_SECURE": "false",
    }

    for key, value in defaults.items():
        if not values.get(key):
            values[key] = value
            changed = True

    if changed:
        _write_env_file(env_file, values)
        ok("Prepared docker/.env for local E2E")


def _parse_env_file(env_file: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    for raw_line in env_file.read_text().splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = _clean_env_value(value)
    return values


def _clean_env_value(value: str) -> str:
    value = value.strip()
    if "#" in value:
        value = value.split("#", 1)[0].strip()
    return value.strip("'\"")


def _write_env_file(env_file: Path, values: dict[str, str]) -> None:
    lines = [
        "# Browsermint local E2E environment",
        "# Generated/updated by test_e2e.py. docker/.env is gitignored.",
    ]
    for key in sorted(values):
        lines.append(f"{key}={values[key]}")
    env_file.write_text("\n".join(lines) + "\n")


def default_base_url_from_env() -> str:
    env_file = DOCKER_DIR / ".env"
    if env_file.exists():
        port = _parse_env_file(env_file).get("NGINX_PORT")
        if port:
            return f"http://localhost:{port}"
    return DEFAULT_BASE_URL

def ensure_postgres_dir() -> None:
    """Ensure POSTGRES_DATA_DIR exists (compose will fail otherwise)."""
    data_dir_value = _parse_env_file(DOCKER_DIR / ".env").get("POSTGRES_DATA_DIR")
    if not data_dir_value:
        fatal("POSTGRES_DATA_DIR missing from docker/.env")
    data_dir = Path(data_dir_value)
    if not data_dir.exists():
        info(f"Creating POSTGRES_DATA_DIR: {data_dir}")
        data_dir.mkdir(parents=True, exist_ok=True)
        ok(f"Created {data_dir}")


def ensure_browser_image() -> None:
    """Build the browser image used by dynamically-created session containers."""
    env = _parse_env_file(DOCKER_DIR / ".env")
    image = env.get("STEEL_BROWSER_IMAGE", "ihainan/browsermint-browser:0.5.1")
    inspect = run(["docker", "image", "inspect", image], check=False)
    if inspect.returncode == 0:
        ok(f"Browser image available: {image}")
        return

    info(f"Browser image {image} not found — building compose service 'browser'…")
    build = docker_compose("--profile", "build", "build", "browser")
    if build.returncode != 0:
        print(build.stderr)
        fatal("docker compose build browser failed")
    ok(f"Built browser image: {image}")

def ensure_services_up(base_url: str) -> None:
    section("Step 1: Docker Services")
    ensure_env_file()
    ensure_postgres_dir()
    ensure_browser_image()

    # Check if all expected services are healthy / running
    result = docker_compose("ps", "--format", "json")
    containers = []
    if result.returncode == 0 and result.stdout.strip():
        for line in result.stdout.strip().splitlines():
            try:
                containers.append(json.loads(line))
            except json.JSONDecodeError:
                pass

    running = {c.get("Service") for c in containers if c.get("State") == "running"}
    required = {"postgres", "backend", "frontend", "nginx"}
    missing = required - running

    if missing:
        info(f"Services not running: {missing} — starting docker compose…")
        up = docker_compose("up", "-d", "--build")
        if up.returncode != 0:
            print(up.stderr)
            fatal("docker compose up failed")
        ok("docker compose up -d")
    else:
        ok("All services already running")

    # Wait for HTTP to respond
    info("Waiting for backend to be reachable…")
    deadline = time.time() + 60
    while time.time() < deadline:
        try:
            r = requests.get(f"{base_url}/api/auth/config", timeout=3)
            if r.status_code < 500:
                break
        except requests.RequestException:
            pass
        time.sleep(2)
    else:
        fatal(f"Backend at {base_url} did not become reachable within 60s")

    ok(f"Backend reachable at {base_url}")

# ─── Auth Helpers ──────────────────────────────────────────────────────────────

def ensure_user_and_login(base_url: str, email: str, username: str, password: str) -> requests.Session:
    section("Step 2: User Auth")
    s = requests.Session()

    # Try login first
    r = s.post(f"{base_url}/api/auth/login", json={"email": email, "password": password})
    if r.status_code == 200:
        user = r.json()["user"]
        ok(f"Logged in as {user['email']} (isAdmin={user['isAdmin']})")
        return s

    # Login failed — try to register
    r2 = s.post(f"{base_url}/api/auth/register", json={
        "username": username, "email": email, "password": password
    })
    if r2.status_code in (200, 201):
        user = r2.json()["user"]
        ok(f"Registered new user {user['email']} (isAdmin={user['isAdmin']})")

        # maxSessions=0 means UNLIMITED (backend check: `maxSessions > 0 && count >= max`)
        # so 0 is fine for testing
        return s

    # Both failed
    info(f"Login response: {r.text}")
    info(f"Register response: {r2.text}")
    fatal(f"Cannot login or register as {email}")
    return s  # unreachable

# ─── Session Helpers ───────────────────────────────────────────────────────────

def wait_for_session_running(base_url: str, s: requests.Session, session_id: str) -> dict:
    """Poll GET /api/sessions/:id until status is 'running' or timeout."""
    deadline = time.time() + SESSION_READY_TIMEOUT
    while time.time() < deadline:
        r = s.get(f"{base_url}/api/sessions/{session_id}")
        if r.status_code == 200:
            sess = r.json()["session"]
            status = sess["status"]
            if status == "running":
                return sess
            if status in ("error", "stopped"):
                fatal(f"Session {session_id} entered status '{status}' during creation")
        time.sleep(SESSION_WAIT_POLL)
    fatal(f"Session {session_id} did not become 'running' within {SESSION_READY_TIMEOUT}s")
    return {}

def ensure_session(base_url: str, s: requests.Session, reuse_any_session: bool) -> tuple[str, str, bool]:
    """Return (session_id, token, created_by_e2e) for a running session."""
    section("Step 3: Session")

    # List existing sessions
    r = s.get(f"{base_url}/api/sessions")
    sessions = r.json().get("sessions", []) if r.status_code == 200 else []
    usable = [
        x for x in sessions
        if x["status"] in ("running", "paused") and (reuse_any_session or x.get("name") == DEFAULT_SESSION_NAME)
    ]

    if usable:
        sess = usable[0]
        session_id = sess["id"]
        info(f"Reusing existing session {session_id} (status={sess['status']})")
        if sess["status"] == "paused":
            info("Session is paused — it will auto-unpause on first WS connect")
        ok(f"Using session {session_id}")
        created_by_e2e = False
    else:
        info("No usable session found — creating a new one…")
        r2 = s.post(f"{base_url}/api/sessions", json={"name": DEFAULT_SESSION_NAME})
        if r2.status_code >= 400:
            info(f"Create session response ({r2.status_code}): {r2.text}")
            fatal("Failed to create session — check maxSessions limit")
        session_id = r2.json()["session"]["id"]
        info(f"Session {session_id} created, waiting for 'running'…")
        sess = wait_for_session_running(base_url, s, session_id)
        ok(f"Session {session_id} is running")
        created_by_e2e = True

    # Get / refresh token
    r3 = s.post(f"{base_url}/api/sessions/{session_id}/token", json={})
    if r3.status_code != 200:
        fatal(f"Failed to get session token: {r3.text}")
    token = r3.json()["token"]
    ok("Session token obtained")

    return session_id, token, created_by_e2e


def cleanup_session(base_url: str, s: requests.Session, session_id: str) -> None:
    section("Cleanup")
    r = s.delete(f"{base_url}/api/sessions/{session_id}", timeout=30)
    if r.status_code == 200:
        ok(f"Deleted E2E session {session_id}")
    elif r.status_code == 404:
        ok(f"E2E session {session_id} already gone")
    else:
        fail(f"Delete E2E session {session_id}", f"{r.status_code}: {r.text[:120]}")

# ─── HTTP API Tests ────────────────────────────────────────────────────────────

def test_http_apis(base_url: str, s: requests.Session, session_id: str, token: str) -> None:
    section("Step 4: HTTP Proxy APIs")

    # GET /api/sessions/:id
    r = s.get(f"{base_url}/api/sessions/{session_id}")
    if r.status_code == 200 and r.json().get("session"):
        ok("GET /api/sessions/:id", f"status={r.json()['session']['status']}")
    else:
        fail("GET /api/sessions/:id", r.text[:80])

    # GET /api/sessions/:id/details
    r = requests.get(f"{base_url}/api/sessions/{session_id}/details", params={"token": token})
    if r.status_code == 200:
        detail = r.json()
        ws_url = detail.get("websocketUrl", "")
        ok("GET /details", f"websocketUrl={'present' if ws_url else 'missing'}")
    else:
        fail("GET /details", r.text[:80])

    # GET /api/sessions/:id/targets  (list tabs)
    r = requests.get(f"{base_url}/api/sessions/{session_id}/targets", params={"token": token})
    if r.status_code == 200:
        targets = r.json().get("targets", [])
        ok("GET /targets", f"{len(targets)} tab(s)")
    else:
        fail("GET /targets", r.text[:80])

    # POST /api/sessions/:id/targets  (create new tab)
    r = requests.post(
        f"{base_url}/api/sessions/{session_id}/targets",
        params={"token": token},
        json={"url": "about:blank"},
    )
    if r.status_code == 200:
        new_target_id = r.json().get("targetId", "")
        ok("POST /targets (create tab)", f"targetId={new_target_id[:20]}…")
    else:
        fail("POST /targets", r.text[:80])
        new_target_id = ""

    # Resolve an active targetId (needed for navigate/go-back/reload)
    r_tgt = requests.get(f"{base_url}/api/sessions/{session_id}/targets", params={"token": token})
    active_target_id = ""
    if r_tgt.status_code == 200:
        tgts = r_tgt.json().get("targets", [])
        if tgts:
            active_target_id = tgts[0]["targetId"]

    # POST /api/sessions/:id/navigate  (requires url + targetId)
    if active_target_id:
        r = requests.post(
            f"{base_url}/api/sessions/{session_id}/navigate",
            params={"token": token},
            json={"url": "https://example.com", "targetId": active_target_id},
        )
        if r.status_code == 200:
            ok("POST /navigate (example.com)")
        else:
            fail("POST /navigate", r.text[:80])

        # Navigate to a second page so go-back has history
        requests.post(
            f"{base_url}/api/sessions/{session_id}/navigate",
            params={"token": token},
            json={"url": "https://example.org", "targetId": active_target_id},
        )

        # POST /api/sessions/:id/go-back
        r = requests.post(
            f"{base_url}/api/sessions/{session_id}/go-back",
            params={"token": token},
            json={"targetId": active_target_id},
        )
        if r.status_code == 200:
            ok("POST /go-back")
        else:
            fail("POST /go-back", r.text[:80])

        # POST /api/sessions/:id/go-forward
        r = requests.post(
            f"{base_url}/api/sessions/{session_id}/go-forward",
            params={"token": token},
            json={"targetId": active_target_id},
        )
        if r.status_code == 200:
            ok("POST /go-forward")
        else:
            fail("POST /go-forward", r.text[:80])

        # POST /api/sessions/:id/reload
        r = requests.post(
            f"{base_url}/api/sessions/{session_id}/reload",
            params={"token": token},
            json={"targetId": active_target_id},
        )
        if r.status_code == 200:
            ok("POST /reload")
        else:
            fail("POST /reload", r.text[:80])

        # POST /api/sessions/:id/targets/:targetId/activate
        r = requests.post(
            f"{base_url}/api/sessions/{session_id}/targets/{active_target_id}/activate",
            params={"token": token},
            json={},
        )
        if r.status_code == 200:
            ok("POST /targets/:targetId/activate")
        else:
            fail("POST /targets/:targetId/activate", r.text[:80])
    else:
        fail("POST /navigate,/go-back,/go-forward,/reload,/activate", "no active targetId")

    # DELETE /api/sessions/:id/targets/:targetId  (close the tab we created)
    if new_target_id:
        r = requests.delete(
            f"{base_url}/api/sessions/{session_id}/targets/{new_target_id}",
            params={"token": token},
        )
        if r.status_code == 200:
            ok("DELETE /targets/:targetId (close tab)")
        else:
            fail("DELETE /targets/:targetId", r.text[:80])

    # GET /api/sessions/:id/events
    r = s.get(f"{base_url}/api/sessions/{session_id}/events")
    if r.status_code == 200:
        events = r.json().get("events", [])
        ok("GET /events", f"{len(events)} event(s) logged")
    else:
        fail("GET /events", r.text[:80])

    # GET /events/stats
    r = s.get(f"{base_url}/api/sessions/events/stats")
    if r.status_code == 200:
        ok("GET /events/stats")
    else:
        fail("GET /events/stats", r.text[:80])

# ─── CDP WebSocket Tests ───────────────────────────────────────────────────────

async def _recv_until(ws: ClientConnection, target_id: int, timeout: float = 8.0) -> dict:
    """Receive messages until we get the response with the given id."""
    deadline = asyncio.get_event_loop().time() + timeout
    while True:
        remaining = deadline - asyncio.get_event_loop().time()
        if remaining <= 0:
            raise TimeoutError(f"No response for id={target_id} within {timeout}s")
        msg = json.loads(await asyncio.wait_for(ws.recv(), timeout=remaining))
        if msg.get("id") == target_id:
            return msg

async def _send(ws: ClientConnection, cmd: dict) -> dict:
    """Send a CDP command and wait for its response (ignores events)."""
    await ws.send(json.dumps(cmd))
    return await _recv_until(ws, cmd["id"])

async def test_cdp_websocket(base_url: str, session_id: str, token: str) -> None:
    section("Step 5: CDP WebSocket")

    ws_url = f"{base_url.replace('http', 'ws')}/ws/sessions/{session_id}/cdp?token={token}"
    info(f"Connecting to {ws_url[:80]}…")

    async with websockets.connect(ws_url, open_timeout=20) as ws:
        ok("WebSocket connected to CDP bridge")

        # ── 1. Browser.getVersion ──────────────────────────────────────────────
        resp = await _send(ws, {"id": 1, "method": "Browser.getVersion"})
        if "result" in resp:
            product = resp["result"]["product"]
            ok("Browser.getVersion", product)
        else:
            fail("Browser.getVersion", str(resp.get("error")))

        # ── 2. Target.getTargets ──────────────────────────────────────────────
        resp = await _send(ws, {"id": 2, "method": "Target.getTargets"})
        if "result" in resp:
            targets = resp["result"]["targetInfos"]
            pages = [t for t in targets if t["type"] == "page"]
            ok("Target.getTargets", f"{len(targets)} target(s), {len(pages)} page(s)")
        else:
            fail("Target.getTargets", str(resp.get("error")))

        if not pages:
            fail("CDP: No page targets available — skipping page-level tests")
            return

        page_target = pages[0]

        # ── 3. Target.attachToTarget ──────────────────────────────────────────
        resp = await _send(ws, {
            "id": 3,
            "method": "Target.attachToTarget",
            "params": {"targetId": page_target["targetId"], "flatten": True},
        })
        if "result" in resp:
            page_session = resp["result"]["sessionId"]
            ok("Target.attachToTarget", f"sessionId={page_session[:20]}…")
        else:
            fail("Target.attachToTarget", str(resp.get("error")))
            return

        # ── 4. Page.navigate ──────────────────────────────────────────────────
        resp = await _send(ws, {
            "id": 4,
            "method": "Page.navigate",
            "params": {"url": "https://example.com"},
            "sessionId": page_session,
        })
        if "result" in resp:
            frame_id = resp["result"].get("frameId", "")
            ok("Page.navigate (example.com)", f"frameId={frame_id[:20]}…")
        else:
            fail("Page.navigate", str(resp.get("error")))

        # Brief wait for page load
        await asyncio.sleep(2)

        # ── 5. Runtime.evaluate — basic JS ───────────────────────────────────
        resp = await _send(ws, {
            "id": 5,
            "method": "Runtime.evaluate",
            "params": {"expression": "document.title", "returnByValue": True},
            "sessionId": page_session,
        })
        if "result" in resp:
            title = resp["result"]["result"].get("value", "")
            ok("Runtime.evaluate (document.title)", repr(title))
        else:
            fail("Runtime.evaluate", str(resp.get("error")))

        # ── 6. Stealth: navigator.webdriver ──────────────────────────────────
        resp = await _send(ws, {
            "id": 6,
            "method": "Runtime.evaluate",
            "params": {"expression": "navigator.webdriver", "returnByValue": True},
            "sessionId": page_session,
        })
        if "result" in resp:
            val = resp["result"]["result"].get("value")
            if val is False or val is None:
                ok("Stealth: navigator.webdriver = false/undefined", str(val))
            else:
                fail("Stealth: navigator.webdriver should be false", f"got {val!r}")
        else:
            fail("Stealth: navigator.webdriver check", str(resp.get("error")))

        # ── 7. Stealth: window.chrome ────────────────────────────────────────
        resp = await _send(ws, {
            "id": 7,
            "method": "Runtime.evaluate",
            "params": {"expression": "typeof window.chrome !== 'undefined'", "returnByValue": True},
            "sessionId": page_session,
        })
        if "result" in resp:
            val = resp["result"]["result"].get("value")
            if val is True:
                ok("Stealth: window.chrome exists")
            else:
                fail("Stealth: window.chrome missing", f"got {val!r}")
        else:
            fail("Stealth: window.chrome check", str(resp.get("error")))

        # ── 8. Stealth: navigator.plugins ────────────────────────────────────
        resp = await _send(ws, {
            "id": 8,
            "method": "Runtime.evaluate",
            "params": {"expression": "navigator.plugins.length > 0", "returnByValue": True},
            "sessionId": page_session,
        })
        if "result" in resp:
            val = resp["result"]["result"].get("value")
            if val is True:
                ok("Stealth: navigator.plugins.length > 0")
            else:
                fail("Stealth: navigator.plugins should be non-empty", f"got {val!r}")
        else:
            fail("Stealth: navigator.plugins check", str(resp.get("error")))

        # ── 9. Passkey override ───────────────────────────────────────────────
        expr = (
            "PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()"
            ".then(v => String(v))"
        )
        resp = await _send(ws, {
            "id": 9,
            "method": "Runtime.evaluate",
            "params": {"expression": expr, "returnByValue": True, "awaitPromise": True},
            "sessionId": page_session,
        })
        if "result" in resp:
            val = resp["result"]["result"].get("value")
            if val == "false":
                ok("Passkey override: isUserVerifyingPlatformAuthenticatorAvailable() = false")
            else:
                fail("Passkey override: expected 'false'", f"got {val!r}")
        else:
            fail("Passkey override check", str(resp.get("error")))

        # ── 10. Runtime.evaluate — complex expression ─────────────────────────
        expr = "[navigator.userAgent, navigator.language, screen.width].join('|')"
        resp = await _send(ws, {
            "id": 10,
            "method": "Runtime.evaluate",
            "params": {"expression": expr, "returnByValue": True},
            "sessionId": page_session,
        })
        if "result" in resp:
            val = resp["result"]["result"].get("value", "")
            ok("Runtime.evaluate (ua|lang|screen)", val[:60])
        else:
            fail("Runtime.evaluate complex", str(resp.get("error")))

        # ── 11. Page.getFrameTree ────────────────────────────────────────────
        resp = await _send(ws, {
            "id": 11,
            "method": "Page.getFrameTree",
            "params": {},
            "sessionId": page_session,
        })
        if "result" in resp:
            url = resp["result"]["frameTree"]["frame"].get("url", "")
            ok("Page.getFrameTree", url[:60])
        else:
            fail("Page.getFrameTree", str(resp.get("error")))

        # ── 12. Target.createTarget + Target.closeTarget ─────────────────────
        resp = await _send(ws, {
            "id": 12,
            "method": "Target.createTarget",
            "params": {"url": "about:blank"},
        })
        if "result" in resp:
            new_target_id = resp["result"]["targetId"]
            ok("Target.createTarget (new tab)", f"targetId={new_target_id[:20]}…")

            # Close it
            resp2 = await _send(ws, {
                "id": 13,
                "method": "Target.closeTarget",
                "params": {"targetId": new_target_id},
            })
            if "result" in resp2:
                ok("Target.closeTarget (close tab)")
            else:
                fail("Target.closeTarget", str(resp2.get("error")))
        else:
            fail("Target.createTarget", str(resp.get("error")))

        # ── 13. Multiple concurrent commands ─────────────────────────────────
        # Send 3 commands rapidly; verify all 3 come back
        cmds = [
            {"id": 20, "method": "Browser.getVersion"},
            {"id": 21, "method": "Target.getTargets"},
            {"id": 22, "method": "Target.getBrowserContexts"},
        ]
        for c in cmds:
            await ws.send(json.dumps(c))
        results = {}
        deadline = asyncio.get_event_loop().time() + 10
        while len(results) < 3:
            remaining = deadline - asyncio.get_event_loop().time()
            if remaining <= 0:
                break
            try:
                msg = json.loads(await asyncio.wait_for(ws.recv(), timeout=remaining))
                if msg.get("id") in {20, 21, 22}:
                    results[msg["id"]] = "result" in msg
            except (TimeoutError, asyncio.TimeoutError):
                break
        if len(results) == 3 and all(results.values()):
            ok("Multiple concurrent commands (3 back-to-back)")
        else:
            fail("Multiple concurrent commands", f"received={list(results.keys())}")


async def test_other_websockets(base_url: str, session_id: str, token: str) -> None:
    section("Step 6: Other WebSocket Endpoints")
    ws_base = base_url.replace("http", "ws")

    # ── Cast WS (browser screen streaming) ───────────────────────────────────
    cast_url = f"{ws_base}/ws/sessions/{session_id}/cast?token={token}"
    try:
        async with websockets.connect(cast_url, open_timeout=15) as ws:
            # Just verify we can connect; cast streams are one-way from server
            await asyncio.sleep(0.5)
            ok("WS /cast connected (browser screen stream)")
    except Exception as e:
        fail("WS /cast", str(e)[:80])

    # ── Logs WS ───────────────────────────────────────────────────────────────
    logs_url = f"{ws_base}/ws/sessions/{session_id}/logs?token={token}"
    try:
        async with websockets.connect(logs_url, open_timeout=15) as ws:
            await asyncio.sleep(0.5)
            ok("WS /logs connected (console log stream)")
    except Exception as e:
        fail("WS /logs", str(e)[:80])

    # ── PageId WS ─────────────────────────────────────────────────────────────
    pageid_url = f"{ws_base}/ws/sessions/{session_id}/pageId?token={token}"
    try:
        async with websockets.connect(pageid_url, open_timeout=15) as ws:
            await asyncio.sleep(0.5)
            ok("WS /pageId connected (active tab changes)")
    except Exception as e:
        fail("WS /pageId", str(e)[:80])


# ─── Session Events Verification ──────────────────────────────────────────────

def test_session_events(base_url: str, s: requests.Session, session_id: str) -> None:
    section("Step 7: Session Events Log")

    r = s.get(f"{base_url}/api/sessions/{session_id}/events")
    if r.status_code != 200:
        fail("GET /events (final check)", r.text[:80])
        return

    events = r.json().get("events", [])
    op_types = {e["operationType"] for e in events}
    sources  = {e.get("source") for e in events}

    ok(f"Total events logged: {len(events)}")

    # Expect at least some of these op types from our test run
    expected_types = {"ws_cdp", "targets_list", "session_details"}
    found = expected_types & op_types
    missing = expected_types - op_types
    if found:
        ok(f"Expected event types present: {sorted(found)}")
    if missing:
        fail(f"Expected event types missing: {sorted(missing)}")

    # Sources
    if "agent" in sources:
        ok("Events correctly tagged with source='agent'")
    else:
        fail("No events tagged as source='agent'")


# ─── Admin API Sanity Check ────────────────────────────────────────────────────

def test_admin_apis(base_url: str, s: requests.Session) -> None:
    section("Step 8: Admin APIs (if admin user)")

    # Check if current user is admin
    r = s.get(f"{base_url}/api/auth/me")
    if r.status_code != 200:
        info("Could not check /api/auth/me — skipping admin tests")
        return

    user = r.json().get("user", {})
    if not user.get("isAdmin"):
        info("Not an admin user — skipping admin tests")
        return

    # GET /api/admin/users
    r = s.get(f"{base_url}/api/admin/users")
    if r.status_code == 200:
        users = r.json().get("users", [])
        ok("GET /admin/users", f"{len(users)} user(s)")
    else:
        fail("GET /admin/users", r.text[:80])

    # GET /api/admin/sessions
    r = s.get(f"{base_url}/api/admin/sessions")
    if r.status_code == 200:
        sessions = r.json().get("sessions", [])
        ok("GET /admin/sessions", f"{len(sessions)} session(s)")
    else:
        fail("GET /admin/sessions", r.text[:80])


# ─── Main ──────────────────────────────────────────────────────────────────────

async def async_main(base_url: str, session_id: str, token: str) -> None:
    await test_cdp_websocket(base_url, session_id, token)
    await test_other_websockets(base_url, session_id, token)


def main() -> None:
    parser = argparse.ArgumentParser(description="Browsermint E2E Tests")
    parser.add_argument("--base-url",  default=None, help="Base URL of Browsermint (defaults to docker/.env NGINX_PORT)")
    parser.add_argument("--email",     default=DEFAULT_EMAIL,    help="Test user email")
    parser.add_argument("--username",  default=DEFAULT_USERNAME, help="Test user username")
    parser.add_argument("--password",  default=DEFAULT_PASSWORD, help="Test user password")
    parser.add_argument("--skip-docker", action="store_true",    help="Skip docker setup step")
    parser.add_argument("--reuse-any-session", action="store_true", help="Allow reusing any running/paused session, not just E2E-named sessions")
    parser.add_argument("--keep-session", action="store_true", help="Do not delete a session created by this E2E run")
    args = parser.parse_args()

    if not args.skip_docker:
        ensure_env_file()
    base_url = args.base_url or default_base_url_from_env()

    print(f"\n{BOLD}Browsermint E2E Test Suite{RESET}", flush=True)
    print(f"Target: {base_url}", flush=True)

    if not args.skip_docker:
        ensure_services_up(base_url)
    else:
        section("Step 1: Docker Services")
        info("Skipped (--skip-docker)")

    session = ensure_user_and_login(base_url, args.email, args.username, args.password)
    session_id, token, created_by_e2e = ensure_session(base_url, session, args.reuse_any_session)

    try:
        test_http_apis(base_url, session, session_id, token)

        asyncio.run(async_main(base_url, session_id, token))

        test_session_events(base_url, session, session_id)
        test_admin_apis(base_url, session)
    finally:
        if created_by_e2e and not args.keep_session:
            cleanup_session(base_url, session, session_id)

    _print_summary()
    sys.exit(0 if _failed == 0 else 1)


if __name__ == "__main__":
    main()
