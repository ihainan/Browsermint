# Browsermint on Kubernetes

The backend runs with `SESSION_DRIVER=kubernetes`: each browser session becomes
a Pod (+ per-session headless Service for stable DNS, + profile PVC on NFS) in
this namespace. Idle-pause / stop delete the Pod and keep the PVC; resume
recreates the Pod. See `backend/src/services/driver/kubernetes.driver.ts`.

## Prereqs (once per cluster/namespace)

```bash
export KUBECONFIG=...   # cluster admin-ish access
export NO_PROXY="localhost,127.0.0.1,10.0.0.0/8,192.168.0.0/16"; export no_proxy="$NO_PROXY"

# 1. Namespace — do NOT add PodSecurity labels: session pods run Chrome with
#    --no-sandbox as root and mount NFS PVCs; an unlabeled ns has no enforcement.
kubectl create ns browsermint

# 2. Harbor pull secret (copy from an existing ns and verify it contains an
#    auth entry for harbor.inner.bza.edu.cn, not only the push IP):
kubectl -n openclaw-agents get secret harbor-registry -o yaml \
  | sed 's/namespace: openclaw-agents/namespace: browsermint/' | kubectl apply -f -

# 3. CNPG database (operator already installed cluster-wide):
kubectl -n browsermint apply -f prereqs/cnpg-cluster.yaml
kubectl -n browsermint get cluster browsermint-pg   # wait until healthy

# 4. Backend env secret (rotate the values in docker/.env — they are for the
#    legacy compose deployment and were committed once):
kubectl -n browsermint create secret generic browsermint-backend-env \
  --from-literal=JWT_SECRET="$(openssl rand -hex 32)" \
  --from-literal=JWT_SESSION_TOKEN_SECRET="$(openssl rand -hex 32)" \
  --from-literal=SERVICE_ASSERTION_SECRET="$(openssl rand -hex 32)"
# Optional extra keys: CAPSOLVER_API_KEY, SERVICE_AGENT_TOKEN_EXPIRY, LOG_LEVEL.

# 5. TLS secret for the inner host (Inner-CA wildcard cert):
kubectl -n browsermint create secret tls browsermint-inner-tls \
  --cert=inner-wildcard.crt --key=inner-wildcard.key
```

## Build & push images

```bash
HARBOR_PASSWORD=... ../build-and-push.sh all
```

Prints the `harbor.inner.bza.edu.cn/...` pull references + tag for
`values-prod.yaml`. After any registry change verify a **genuinely fresh
pull** (skopeo copy to a clean dir, or a pod on a cache-less node) — "Running"
pods may just have cached layers.

## Deploy

```bash
cp values.example.yaml values-prod.yaml   # gitignored; fill in image tags
helm -n browsermint upgrade --install browsermint . -f values-prod.yaml
kubectl -n browsermint get deploy,po,svc,ingress
```

Smoke test from a node / the ops machine:

```bash
curl -sk --resolve browsermint.inner.bza.edu.cn:443:<worker-ip> \
  https://browsermint.inner.bza.edu.cn/health
```

Then create a session in the UI and watch `kubectl -n browsermint get po -w`:
a `browsermint-session-<uuid>` pod (+Service +PVC) should appear, the noVNC
view should work, and after the idle timeout the pod (not the PVC) disappears.

## Notes / gotchas

- **Backend is replicas=1 + Recreate** — in-memory CDP/WS state and
  `prisma migrate deploy` in the CMD. Do not scale it.
- Session pods get `/dev/shm` as a memory-backed emptyDir (`session.shmSize`,
  counted against the pod memory limit) — Chrome crashes with the 64Mi default.
- Chrome profiles live on NFS PVCs; stale `Singleton*` locks are cleaned at pod
  start. A SIGKILLed pod can still corrupt SQLite state — the reconcile loop
  recreates the pod and, worst case, the session resumes with an empty profile.
- Resume after idle-pause takes pod-start time (typically 10–60 s; first pull
  on a cache-less node can take minutes — hence `session.podStartTimeoutMs`).
  Tabs are restored from `savedTabs`; in-page state is not.
- The ingress keeps `proxy-buffering off` + 3600 s timeouts for the CDP/VNC
  WebSockets. Keep those annotations when editing.
- Agent platform integration: enable `SERVICE_ASSERTION_SECRET` and the
  platform mints per-agent accounts via `POST /api/service/agent-tokens`.
