import axios from "axios";

export const api = axios.create({
  baseURL: "/api",
  headers: { "Content-Type": "application/json" },
});

// Attach auth token to every request
api.interceptors.request.use((config) => {
  const token = localStorage.getItem("steelyard_token");
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// Redirect to /login on 401
api.interceptors.response.use(
  (res) => res,
  (err) => {
    if (err.response?.status === 401) {
      localStorage.removeItem("steelyard_token");
      localStorage.removeItem("steelyard_user");
      if (window.location.pathname !== "/login") {
        window.location.href = "/login";
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
}

export interface Session {
  id: string;
  userId: string;
  name: string | null;
  status: "creating" | "running" | "stopping" | "stopped" | "error";
  containerId: string | null;
  containerName: string | null;
  internalApiUrl: string | null;
  createdAt: string;
  lastActiveAt: string;
  deletedAt: string | null;
}

export interface SteelSessionDetails {
  id?: string;
  createdAt?: string;
  duration?: number;
  userAgent?: string;
  solveCaptcha?: boolean;
  isSelenium?: boolean;
  websocketUrl?: string;
  proxyTxBytes?: number;
  proxyRxBytes?: number;
  creditsUsed?: number;
  proxy?: string;
  status?: string;
}

export const authApi = {
  register: (data: { username: string; email: string; password: string }) =>
    api.post<{ user: User; token: string }>("/auth/register", data),
  login: (data: { email: string; password: string }) =>
    api.post<{ user: User; token: string }>("/auth/login", data),
  me: () => api.get<{ user: User }>("/auth/me"),
};

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
  getToken: (id: string) =>
    api.post<{ token: string }>(`/sessions/${id}/token`),
};
