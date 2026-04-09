import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
} from "react";
import { authApi, User } from "../api/client.ts";

interface AuthContextValue {
  user: User | null;
  isLoading: boolean;
  registrationEnabled: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (username: string, email: string, password: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [registrationEnabled, setRegistrationEnabled] = useState(true);

  // Restore session and fetch server config on mount.
  // Auth state is derived from the HttpOnly cookie via /me — no localStorage needed.
  useEffect(() => {
    authApi.getConfig()
      .then((res) => setRegistrationEnabled(res.data.registrationEnabled))
      .catch(() => { /* keep default true on failure */ });

    authApi
      .me()
      .then((res) => setUser(res.data.user))
      .catch(() => {
        // Not authenticated — leave user as null
      })
      .finally(() => setIsLoading(false));
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const res = await authApi.login({ email, password });
    setUser(res.data.user);
  }, []);

  const register = useCallback(
    async (username: string, email: string, password: string) => {
      const res = await authApi.register({ username, email, password });
      setUser(res.data.user);
    },
    []
  );

  const logout = useCallback(() => {
    authApi.logout().catch(() => {});
    setUser(null);
  }, []);

  return (
    <AuthContext.Provider value={{ user, isLoading, registrationEnabled, login, register, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
