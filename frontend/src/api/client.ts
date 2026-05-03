import axios from "axios";

export const api = axios.create({
  baseURL: "/api",
  headers: { "Content-Type": "application/json", "X-Browsermint-Client": "frontend" },
  withCredentials: true, // send HttpOnly auth cookie automatically on every request
});

// Redirect to /login on 401, but only for auth-protected API calls.
// Session token endpoints return 401 when the per-session token is unavailable
// or stale, not when the user's auth cookie is invalid.
// Treating those as auth failures would log the user out whenever a session stops
// while its details page is still open.
const SESSION_PROXY_PATH = /^\/sessions\/[^/]+\/(details|browser|vnc-viewer|clipboard|devtools(?:\/.*)?|devtools-target|targets(?:\/.*)?|navigate|go-back|go-forward|reload)(?:\?.*)?$/;

api.interceptors.response.use(
  (res) => res,
  (err) => {
    if (err.response?.status === 401) {
      const url: string = err.config?.url ?? "";
      if (!SESSION_PROXY_PATH.test(url)) {
        if (window.location.pathname !== "/login") {
          window.location.href = "/login";
        }
      }
    }
    return Promise.reject(err);
  }
);

// ─── API helpers ──────────────────────────────────────────────────────────────

export interface User {
  id: string;
  username: string;
  email: string;
  createdAt: string;
  maxSessions: number;
  isAdmin: boolean;
}

export interface AdminUser extends User {
  isActive: boolean;
  sessionCount: number;
}

export interface AdminSession {
  id: string;
  name: string | null;
  status: string;
  createdAt: string;
  lastActiveAt: string;
}

export interface AdminSessionFull {
  id: string;
  name: string | null;
  status: string;
  createdAt: string;
  lastActiveAt: string;
  expiresAt: string | null;
  eventCount: number;
  user: { id: string; username: string; email: string };
}

export interface Session {
  id: string;
  userId: string;
  name: string | null;
  status: "creating" | "running" | "stopping" | "stopped" | "error" | "paused";
  containerId: string | null;
  containerName: string | null;
  internalApiUrl: string | null;
  createdAt: string;
  lastActiveAt: string;
  expiresAt: string | null;
  deletedAt: string | null;
  onlineMs: number;
  runningStartedAt: string | null;
}

export interface SteelSessionDetails {
  id?: string;
  createdAt?: string;
  duration?: number;
  userAgent?: string;
  solveCaptcha?: boolean;
  isSelenium?: boolean;
  websocketUrl?: string;
  debuggerUrl?: string;
  proxyTxBytes?: number;
  proxyRxBytes?: number;
  creditsUsed?: number;
  proxy?: string;
  status?: string;
  tokenExpiresAt?: string;
}

export interface SteelDevtoolsTarget {
  pageId: string | null;
  wsPath: string | null;
}

export interface BrowserTab {
  targetId: string;
  type: string;
  title: string;
  url: string;
}

export const authApi = {
  register: (data: { username: string; email: string; password: string }) =>
    api.post<{ user: User }>("/auth/register", data),
  login: (data: { email: string; password: string }) =>
    api.post<{ user: User }>("/auth/login", data),
  me: () => api.get<{ user: User }>("/auth/me"),
  logout: () => api.post<{ success: boolean }>("/auth/logout"),
  getConfig: () => api.get<{ registrationEnabled: boolean }>("/auth/config"),
};

export const adminApi = {
  listUsers: () => api.get<{ users: AdminUser[] }>("/admin/users"),
  createUser: (data: { username: string; email: string; password: string; isAdmin: boolean }) =>
    api.post<{ user: AdminUser }>("/admin/users", data),
  updateUser: (id: string, data: { maxSessions?: number; isAdmin?: boolean; isActive?: boolean }) =>
    api.patch<{ user: AdminUser }>(`/admin/users/${id}`, data),
  resetPassword: (id: string, data: { password: string }) =>
    api.post<{ success: boolean }>(`/admin/users/${id}/reset-password`, data),
  deleteUser: (id: string) => api.delete(`/admin/users/${id}`),
  getUserSessions: (id: string) =>
    api.get<{ sessions: AdminSession[] }>(`/admin/users/${id}/sessions`),
  listSessions: () =>
    api.get<{ sessions: AdminSessionFull[] }>("/admin/sessions"),
};

export interface EventsStats {
  dailyCounts: { date: string; count: number; agentCount: number }[];
  hourlyDistribution: { hour: number; count: number; agentCount: number }[];
  byOperationType: Record<string, number>;
  agentEventCount: number;
  capsolver: { total: number; success: number; failed: number; avgDurationMs: number | null };
}

export const sessionsApi = {
  list: () => api.get<{ sessions: Session[] }>("/sessions"),
  get: (id: string) => api.get<{ session: Session }>(`/sessions/${id}`),
  create: (data: { name?: string }) =>
    api.post<{ session: Session }>("/sessions", data),
  delete: (id: string) => api.delete(`/sessions/${id}`),
  stop: (id: string) => api.post<{ session: Session }>(`/sessions/${id}/stop`),
  start: (id: string) => api.post<{ session: Session }>(`/sessions/${id}/start`),
  getDetails: (id: string, token: string) =>
    api.get<SteelSessionDetails>(`/sessions/${id}/details?token=${token}`),
  getDevtoolsTarget: (id: string, token: string) =>
    api.get<SteelDevtoolsTarget>(`/sessions/${id}/devtools-target?token=${token}`),
  getToken: (id: string) =>
    api.post<{ token: string }>(`/sessions/${id}/token`),
  refreshToken: (id: string) =>
    api.post<{ token: string; session: Session }>(`/sessions/${id}/refresh-token`),
  getTargets: (id: string, token: string) =>
    api.get<{ targets: BrowserTab[] }>(`/sessions/${id}/targets?token=${token}`),
  createTarget: (id: string, token: string, url?: string) =>
    api.post<{ targetId: string }>(`/sessions/${id}/targets?token=${token}`, { url }),
  closeTarget: (id: string, token: string, targetId: string) =>
    api.delete(`/sessions/${id}/targets/${targetId}?token=${token}`),
  activateTarget: (id: string, token: string, targetId: string) =>
    api.post(`/sessions/${id}/targets/${targetId}/activate?token=${token}`),
  navigate: (id: string, token: string, data: { url: string; targetId: string }) =>
    api.post(`/sessions/${id}/navigate?token=${token}`, data),
  goBack: (id: string, token: string, targetId: string) =>
    api.post(`/sessions/${id}/go-back?token=${token}`, { targetId }),
  goForward: (id: string, token: string, targetId: string) =>
    api.post(`/sessions/${id}/go-forward?token=${token}`, { targetId }),
  browserReload: (id: string, token: string, targetId: string) =>
    api.post(`/sessions/${id}/reload?token=${token}`, { targetId }),
  getEventsStats: () => api.get<EventsStats>("/sessions/events/stats"),
};
