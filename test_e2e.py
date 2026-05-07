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
PHASE2_SESSION_NAME = "Browsermint E2E Phase 2 Security"

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

def unique_suffix() -> str:
    return f"{int(time.time())}-{secrets.token_hex(3)}"

def sql_literal(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"

def docker_psql(sql: str) -> subprocess.CompletedProcess:
    env = _parse_env_file(DOCKER_DIR / ".env")
    user = env.get("POSTGRES_USER", "browsermint")
    db = env.get("POSTGRES_DB", "browsermint")
    return docker_compose(
        "exec",
        "-T",
        "postgres",
        "psql",
        "-v",
        "ON_ERROR_STOP=1",
        "-U",
        user,
        "-d",
        db,
        "-c",
        sql,
    )

def require_psql(sql: str, label: str) -> bool:
    result = docker_psql(sql)
    if result.returncode == 0:
        return True
    fail(label, (result.stderr or result.stdout)[:160])
    return False

def docker_pause(container_id: str) -> bool:
    result = run(["docker", "pause", container_id], check=False)
    if result.returncode == 0:
        return True
    fail("docker pause session container", (result.stderr or result.stdout)[:160])
    return False

def docker_unpause(container_id: str) -> None:
    run(["docker", "unpause", container_id], check=False)

def compose_down(remove_volumes: bool = False) -> None:
    args = ["down"]
    if remove_volumes:
        args.append("-v")
    result = docker_compose(*args)
    if result.returncode == 0:
        ok("docker compose down" + (" -v" if remove_volumes else ""))
    else:
        fail("docker compose down", result.stderr[:160])

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

def register_new_user(base_url: str, email: str, username: str, password: str) -> requests.Session | None:
    s = requests.Session()
    r = s.post(f"{base_url}/api/auth/register", json={
        "username": username,
        "email": email,
        "password": password,
    })
    if r.status_code in (200, 201):
        return s
    fail(f"Register fixture user {email}", f"{r.status_code}: {r.text[:120]}")
    return None

def login_user(base_url: str, email: str, password: str) -> requests.Session | None:
    s = requests.Session()
    r = s.post(f"{base_url}/api/auth/login", json={"email": email, "password": password})
    if r.status_code == 200:
        return s
    fail(f"Login fixture user {email}", f"{r.status_code}: {r.text[:120]}")
    return None

def expect_login_rejected(base_url: str, email: str, password: str, label: str) -> None:
    r = requests.post(f"{base_url}/api/auth/login", json={"email": email, "password": password})
    if r.status_code == 401:
        ok(label)
    else:
        fail(label, f"{r.status_code}: {r.text[:120]}")

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

def wait_for_session_status(base_url: str, s: requests.Session, session_id: str, expected: str, timeout: int = 30) -> dict | None:
    deadline = time.time() + timeout
    last_status = "unknown"
    while time.time() < deadline:
        r = s.get(f"{base_url}/api/sessions/{session_id}")
        if r.status_code == 200:
            sess = r.json().get("session", {})
            last_status = sess.get("status", "unknown")
            if last_status == expected:
                return sess
        time.sleep(1)
    fail(f"Wait for session status {expected}", f"last_status={last_status}")
    return None

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


def test_stale_session_token(base_url: str, s: requests.Session, session_id: str, token: str) -> str:
    section("Step 4b: Phase 2 Stale Token Revocation")

    # JWT iat has second-level precision; wait so the refreshed token is newer.
    time.sleep(1.1)
    r = s.post(f"{base_url}/api/sessions/{session_id}/refresh-token", json={})
    if r.status_code != 200:
        fail("POST /refresh-token", r.text[:120])
        return token

    new_token = r.json().get("token", "")
    if not new_token or new_token == token:
        fail("POST /refresh-token returns a new token")
        return token
    ok("POST /refresh-token returns a new token")

    old = requests.get(f"{base_url}/api/sessions/{session_id}/targets", params={"token": token})
    if old.status_code == 401:
        ok("Old session token rejected by HTTP proxy")
    else:
        fail("Old session token rejected by HTTP proxy", f"{old.status_code}: {old.text[:120]}")

    fresh = requests.get(f"{base_url}/api/sessions/{session_id}/targets", params={"token": new_token})
    if fresh.status_code == 200:
        ok("Refreshed session token accepted by HTTP proxy")
    else:
        fail("Refreshed session token accepted by HTTP proxy", f"{fresh.status_code}: {fresh.text[:120]}")

    ws_url = f"{base_url.replace('http', 'ws')}/ws/sessions/{session_id}/cdp?token={token}"
    asyncio.run(expect_ws_rejected(ws_url, "Old session token rejected by CDP WebSocket"))
    return new_token


def test_multi_tab_lifecycle(base_url: str, session_id: str, token: str) -> None:
    section("Step 4c: Phase 2 Multi-Tab Lifecycle")

    created_targets: list[str] = []
    original_target_id = ""
    r = requests.get(f"{base_url}/api/sessions/{session_id}/targets", params={"token": token})
    if r.status_code == 200:
        original_targets = r.json().get("targets", [])
        if original_targets:
            original_target_id = original_targets[0].get("targetId", "")

    try:
        for url in ["https://example.com", "https://example.org"]:
            r = requests.post(
                f"{base_url}/api/sessions/{session_id}/targets",
                params={"token": token},
                json={"url": url},
            )
            if r.status_code == 200 and r.json().get("targetId"):
                target_id = r.json()["targetId"]
                created_targets.append(target_id)
                ok("Create additional tab", f"{target_id[:20]}…")
            else:
                fail("Create additional tab", f"{r.status_code}: {r.text[:120]}")

        r = requests.get(f"{base_url}/api/sessions/{session_id}/targets", params={"token": token})
        targets = r.json().get("targets", []) if r.status_code == 200 else []
        if r.status_code == 200 and len(targets) >= len(created_targets):
            ok("List tabs after multi-tab create", f"{len(targets)} tab(s)")
        else:
            fail("List tabs after multi-tab create", f"{r.status_code}: {r.text[:120]}")

        for target_id in created_targets:
            r = requests.post(
                f"{base_url}/api/sessions/{session_id}/targets/{target_id}/activate",
                params={"token": token},
                json={},
            )
            if r.status_code == 200:
                ok("Activate additional tab", f"{target_id[:20]}…")
            else:
                fail("Activate additional tab", f"{r.status_code}: {r.text[:120]}")
    finally:
        if original_target_id:
            requests.post(
                f"{base_url}/api/sessions/{session_id}/targets/{original_target_id}/activate",
                params={"token": token},
                json={},
            )
            time.sleep(0.5)
        for target_id in reversed(created_targets):
            r = requests.delete(
                f"{base_url}/api/sessions/{session_id}/targets/{target_id}",
                params={"token": token},
            )
            if r.status_code == 200:
                ok("Close additional tab", f"{target_id[:20]}…")
            else:
                fail("Close additional tab", f"{r.status_code}: {r.text[:120]}")


def test_paused_session_auto_unpause(base_url: str, s: requests.Session, session_id: str, token: str, docker_available: bool) -> None:
    section("Step 4d: Phase 2 Paused Session Auto-Unpause")
    if not docker_available:
        info("Skipped (--skip-docker)")
        return

    r = s.get(f"{base_url}/api/sessions/{session_id}")
    if r.status_code != 200:
        fail("Read session before forced pause", r.text[:120])
        return

    session = r.json().get("session", {})
    container_id = session.get("containerId")
    if not container_id:
        fail("Read session containerId before forced pause")
        return

    if not docker_pause(container_id):
        return
    if not require_psql(
        f'UPDATE "Session" SET status = {sql_literal("paused")}, "runningStartedAt" = NULL WHERE id = {sql_literal(session_id)}::uuid;',
        "Mark session paused in DB",
    ):
        docker_unpause(container_id)
        return
    ok("Forced session into paused Docker/DB state")

    try:
        ws_url = f"{base_url.replace('http', 'ws')}/ws/sessions/{session_id}/cdp?token={token}"
        try:
            async def _connect_and_check() -> None:
                async with websockets.connect(ws_url, open_timeout=25) as ws:
                    resp = await _send(ws, {"id": 9902, "method": "Browser.getVersion"})
                    if "result" in resp:
                        ok("Paused session auto-unpaused on CDP WebSocket")
                    else:
                        fail("Paused session auto-unpaused on CDP WebSocket", str(resp.get("error"))[:120])
            asyncio.run(_connect_and_check())
        except Exception as e:
            fail("Paused session auto-unpaused on CDP WebSocket", str(e)[:120])

        sess = wait_for_session_status(base_url, s, session_id, "running")
        if sess:
            ok("Session status is running after auto-unpause")
    finally:
        docker_unpause(container_id)


def test_phase2_admin_security(base_url: str, docker_available: bool) -> None:
    section("Step 8b: Phase 2 Admin + Suspended User Security")
    if not docker_available:
        info("Skipped (--skip-docker)")
        return

    suffix = unique_suffix()
    admin_email = f"e2e_admin_{suffix}@browsermint.local"
    admin_username = f"e2e_admin_{suffix.replace('-', '_')}"
    admin_password = "AdminE2EPass123!"
    managed_email = f"e2e_suspended_{suffix}@browsermint.local"
    managed_username = f"e2e_suspended_{suffix.replace('-', '_')}"
    managed_password = "SuspendedE2EPass123!"
    admin_s: requests.Session | None = None
    managed_s: requests.Session | None = None
    managed_user_id = ""
    managed_session_id = ""

    try:
        if register_new_user(base_url, admin_email, admin_username, admin_password) is None:
            return
        if not require_psql(
            f'UPDATE "User" SET "isAdmin" = true, "isActive" = true, "maxSessions" = 0 WHERE email = {sql_literal(admin_email)};',
            "Promote E2E admin fixture",
        ):
            return
        admin_s = login_user(base_url, admin_email, admin_password)
        if admin_s is None:
            return

        r = admin_s.get(f"{base_url}/api/auth/me")
        if r.status_code == 200 and r.json().get("user", {}).get("isAdmin") is True:
            ok("E2E admin fixture can authenticate as admin")
        else:
            fail("E2E admin fixture can authenticate as admin", f"{r.status_code}: {r.text[:120]}")
            return

        r = admin_s.get(f"{base_url}/api/admin/users")
        if r.status_code == 200:
            ok("Admin GET /admin/users")
        else:
            fail("Admin GET /admin/users", f"{r.status_code}: {r.text[:120]}")
            return

        r = admin_s.post(f"{base_url}/api/admin/users", json={
            "username": managed_username,
            "email": managed_email,
            "password": managed_password,
            "isAdmin": False,
        })
        if r.status_code == 201:
            managed_user_id = r.json()["user"]["id"]
            ok("Admin creates managed user")
        else:
            fail("Admin creates managed user", f"{r.status_code}: {r.text[:120]}")
            return

        managed_s = login_user(base_url, managed_email, managed_password)
        if managed_s is None:
            return
        r = managed_s.post(f"{base_url}/api/sessions", json={"name": PHASE2_SESSION_NAME})
        if r.status_code >= 400:
            fail("Managed user creates session", f"{r.status_code}: {r.text[:120]}")
            return
        managed_session_id = r.json()["session"]["id"]
        wait_for_session_running(base_url, managed_s, managed_session_id)
        ok("Managed user session is running")

        r = managed_s.post(f"{base_url}/api/sessions/{managed_session_id}/token", json={})
        if r.status_code != 200:
            fail("Managed user obtains session token", f"{r.status_code}: {r.text[:120]}")
            return
        managed_token = r.json()["token"]
        ok("Managed user obtains session token")

        r = requests.get(f"{base_url}/api/sessions/{managed_session_id}/targets", params={"token": managed_token})
        if r.status_code == 200:
            ok("Managed user token works before suspension")
        else:
            fail("Managed user token works before suspension", f"{r.status_code}: {r.text[:120]}")

        r = admin_s.get(f"{base_url}/api/admin/users/{managed_user_id}/sessions")
        if r.status_code == 200 and any(x.get("id") == managed_session_id for x in r.json().get("sessions", [])):
            ok("Admin lists managed user's session")
        else:
            fail("Admin lists managed user's session", f"{r.status_code}: {r.text[:120]}")

        r = admin_s.patch(f"{base_url}/api/admin/users/{managed_user_id}", json={"isActive": False})
        if r.status_code == 200 and r.json().get("user", {}).get("isActive") is False:
            ok("Admin suspends managed user")
        else:
            fail("Admin suspends managed user", f"{r.status_code}: {r.text[:120]}")
            return

        expect_login_rejected(base_url, managed_email, managed_password, "Suspended user login rejected")

        r = requests.get(f"{base_url}/api/sessions/{managed_session_id}/targets", params={"token": managed_token})
        if r.status_code == 401:
            ok("Suspended user's existing HTTP proxy token rejected")
        else:
            fail("Suspended user's existing HTTP proxy token rejected", f"{r.status_code}: {r.text[:120]}")

        ws_url = f"{base_url.replace('http', 'ws')}/ws/sessions/{managed_session_id}/cdp?token={managed_token}"
        asyncio.run(expect_ws_rejected(ws_url, "Suspended user's existing CDP WebSocket token rejected"))

        r = admin_s.get(f"{base_url}/api/admin/sessions")
        if r.status_code == 200 and any(x.get("id") == managed_session_id for x in r.json().get("sessions", [])):
            ok("Admin GET /admin/sessions includes managed session")
        else:
            fail("Admin GET /admin/sessions includes managed session", f"{r.status_code}: {r.text[:120]}")
    finally:
        if admin_s is not None and managed_user_id:
            admin_s.patch(f"{base_url}/api/admin/users/{managed_user_id}", json={"isActive": True})
        if managed_s is None and managed_user_id:
            managed_s = login_user(base_url, managed_email, managed_password)
        if managed_s is not None and managed_session_id:
            managed_s.delete(f"{base_url}/api/sessions/{managed_session_id}", timeout=30)
        if admin_s is not None and managed_user_id:
            admin_s.delete(f"{base_url}/api/admin/users/{managed_user_id}")
        require_psql(f'DELETE FROM "User" WHERE email = {sql_literal(admin_email)};', "Delete E2E admin fixture")

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

async def expect_ws_rejected(ws_url: str, label: str) -> None:
    try:
        async with websockets.connect(ws_url, open_timeout=5) as ws:
            await ws.send(json.dumps({"id": 9901, "method": "Browser.getVersion"}))
            try:
                msg = await asyncio.wait_for(ws.recv(), timeout=2)
            except websockets.exceptions.ConnectionClosed:
                ok(label)
                return
            except (TimeoutError, asyncio.TimeoutError):
                fail(label, "connection stayed open without closing")
                return
            fail(label, f"unexpected response: {str(msg)[:120]}")
    except Exception:
        ok(label)

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
    parser.add_argument("--down-after", action="store_true", help="Run docker compose down after the E2E run")
    parser.add_argument("--down-volumes", action="store_true", help="When used with --down-after, also remove compose volumes")
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
        token = test_stale_session_token(base_url, session, session_id, token)
        test_multi_tab_lifecycle(base_url, session_id, token)

        asyncio.run(async_main(base_url, session_id, token))
        test_paused_session_auto_unpause(base_url, session, session_id, token, docker_available=not args.skip_docker)

        test_session_events(base_url, session, session_id)
        test_admin_apis(base_url, session)
        test_phase2_admin_security(base_url, docker_available=not args.skip_docker)
    finally:
        if created_by_e2e and not args.keep_session:
            cleanup_session(base_url, session, session_id)
        if args.down_after:
            section("Docker Teardown")
            compose_down(remove_volumes=args.down_volumes)

    _print_summary()
    sys.exit(0 if _failed == 0 else 1)


if __name__ == "__main__":
    main()
