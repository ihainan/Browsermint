# Browsermint

Browsermint provides a backend API, frontend UI, and Docker-managed browser sessions.

## Test Entrypoints

### Fast Tests

Use the fast suite for normal development and CI checks that should not require Docker browser containers:

```bash
make test-fast
```

This runs:

- `npm --prefix backend test`
- `npm --prefix backend run build`
- `npm --prefix frontend test`
- `npm --prefix frontend run build`

You can also run individual parts:

```bash
make test-backend
make test-frontend
make build
```

### Docker E2E Smoke

Use the Docker E2E smoke test when you want to validate the real compose stack, real browser containers, and real proxy/WebSocket paths:

```bash
make test-e2e
```

Equivalent direct command:

```bash
python3 test_e2e.py
```

The E2E script will:

- prepare `docker/.env` with local-only defaults if required values are missing;
- create `docker/postgres-data/` if needed;
- ensure the configured browser image exists, building the compose `browser` service if necessary;
- run `docker compose up -d --build` from `docker/` when services are not already running;
- register or login the E2E test user;
- create a real browser session named `Browsermint E2E Smoke`;
- exercise HTTP proxy APIs, CDP WebSocket, cast/logs/pageId WebSockets, stealth/passkey checks, session events, and admin sanity checks when applicable;
- delete the session it created unless `--keep-session` is passed.

Useful variants:

```bash
make test-e2e-keep       # keep the created browser session for debugging
make test-e2e-down       # run E2E, then docker compose down
python3 test_e2e.py --base-url http://localhost:24900
python3 test_e2e.py --skip-docker
python3 test_e2e.py --down-after --down-volumes
```

`--base-url` defaults to `http://localhost:${NGINX_PORT}` from `docker/.env`; if `docker/.env` is absent, the fallback is `http://localhost:24700`.

Docker E2E is intentionally separate from the fast suite because it depends on Docker, image availability, real networking, and real browser startup time. Prefer fast tests for inner-loop development and run E2E before release or when changing Docker/browser/proxy behavior.

## Docker Helpers

Start the compose stack:

```bash
make docker-up
```

Stop the compose stack:

```bash
make docker-down
```
