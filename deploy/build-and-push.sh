#!/usr/bin/env bash
# Build the Browsermint backend / frontend / browser images and push them to
# Harbor with skopeo (bypasses dockerd's proxy — the org-standard flow for the
# ZGCAI cluster; see K8S-MIGRATION.md in the AI workspace).
#
# Usage:
#   HARBOR_PASSWORD=... ./deploy/build-and-push.sh [backend|frontend|browser|all]
#
# Env overrides:
#   HARBOR_PUSH_HOST  (default 10.1.132.42)      — push endpoint (self-signed)
#   HARBOR_PROJECT    (default zgci)
#   HARBOR_USER       (default admin)
#   HARBOR_PASSWORD   (required; never passed on a command line)
#   BUILD_PROXY       (default http://127.0.0.1:57777; set empty to disable)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

HARBOR_PUSH_HOST="${HARBOR_PUSH_HOST:-10.1.132.42}"
HARBOR_PROJECT="${HARBOR_PROJECT:-zgci}"
HARBOR_USER="${HARBOR_USER:-admin}"
BUILD_PROXY="${BUILD_PROXY-http://127.0.0.1:57777}"
TARGET="${1:-all}"

if [[ -z "${HARBOR_PASSWORD:-}" ]]; then
  read -r -s -p "Harbor password for ${HARBOR_USER}@${HARBOR_PUSH_HOST}: " HARBOR_PASSWORD
  echo ""
fi

GIT_SHA="$(git -C "$PROJECT_DIR" rev-parse --short HEAD)"
BUILD_TS="$(date -u '+%Y%m%dT%H%M')"
TAG="${BUILD_TS}-${GIT_SHA}"

PROXY_ARGS=()
if [[ -n "$BUILD_PROXY" ]]; then
  PROXY_ARGS=(
    --network=host
    --build-arg "HTTP_PROXY=$BUILD_PROXY" --build-arg "HTTPS_PROXY=$BUILD_PROXY"
    --build-arg "http_proxy=$BUILD_PROXY" --build-arg "https_proxy=$BUILD_PROXY"
    --build-arg "NO_PROXY=localhost,127.0.0.1,10.0.0.0/8,192.168.0.0/16"
    --build-arg "no_proxy=localhost,127.0.0.1,10.0.0.0/8,192.168.0.0/16"
  )
fi

push() {
  local local_ref="$1" remote_repo="$2"
  local dest="docker://${HARBOR_PUSH_HOST}/${HARBOR_PROJECT}/${remote_repo}:${TAG}"
  echo ">>> skopeo push ${local_ref} -> ${dest}"
  # Credentials via a throwaway authfile — never on the command line.
  local authfile
  authfile=$(mktemp)
  chmod 600 "$authfile"
  printf '{"auths":{"%s":{"auth":"%s"}}}' \
    "$HARBOR_PUSH_HOST" \
    "$(printf '%s:%s' "$HARBOR_USER" "$HARBOR_PASSWORD" | base64 -w0)" > "$authfile"
  docker run --rm --net=host \
    -v /var/run/docker.sock:/var/run/docker.sock \
    -v "$authfile":/auth.json:ro \
    quay.io/skopeo/stable:latest copy \
    --dest-tls-verify=false \
    --dest-authfile /auth.json \
    "docker-daemon:${local_ref}" "$dest"
  rm -f "$authfile"
}

build_backend() {
  echo ">>> Building backend image"
  docker build "${PROXY_ARGS[@]}" -f "$PROJECT_DIR/docker/Dockerfile.backend" \
    -t "browsermint-backend:${TAG}" "$PROJECT_DIR"
  push "browsermint-backend:${TAG}" "browsermint-backend"
}

build_frontend() {
  echo ">>> Building frontend image"
  docker build "${PROXY_ARGS[@]}" -f "$PROJECT_DIR/docker/Dockerfile.frontend" \
    -t "browsermint-frontend:${TAG}" "$PROJECT_DIR"
  push "browsermint-frontend:${TAG}" "browsermint-frontend"
}

build_browser() {
  echo ">>> Building browser image"
  # Same base as docker/docker-compose.yml's `browser` build service.
  docker build "${PROXY_ARGS[@]}" -f "$PROJECT_DIR/docker/Dockerfile.browser" \
    --build-arg "STEEL_IMAGE=${STEEL_IMAGE:-ihainan/steel-browser-api:0.5.1-browsermint}" \
    -t "browsermint-browser:${TAG}" "$PROJECT_DIR"
  push "browsermint-browser:${TAG}" "browsermint-browser"
}

case "$TARGET" in
  backend)  build_backend ;;
  frontend) build_frontend ;;
  browser)  build_browser ;;
  all)      build_backend; build_frontend; build_browser ;;
  *) echo "Unknown target: $TARGET (use backend|frontend|browser|all)"; exit 1 ;;
esac

echo ""
echo "Done. Tag: $TAG"
echo "Cluster pull references (values-prod.yaml):"
echo "  harbor.inner.bza.edu.cn/${HARBOR_PROJECT}/browsermint-backend:${TAG}"
echo "  harbor.inner.bza.edu.cn/${HARBOR_PROJECT}/browsermint-frontend:${TAG}"
echo "  harbor.inner.bza.edu.cn/${HARBOR_PROJECT}/browsermint-browser:${TAG}"
