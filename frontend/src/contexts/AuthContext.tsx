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
  token: string | null;
  isLoading: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (username: string, email: string, password: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // Restore session on mount
  useEffect(() => {
    const storedToken = localStorage.getItem("steelyard_token");
    if (!storedToken) {
      setIsLoading(false);
      return;
    }
    setToken(storedToken);
    authApi
      .me()
      .then((res) => setUser(res.data.user))
      .catch(() => {
        localStorage.removeItem("steelyard_token");
        localStorage.removeItem("steelyard_user");
      })
      .finally(() => setIsLoading(false));
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const res = await authApi.login({ email, password });
    const { user, token } = res.data;
    localStorage.setItem("steelyard_token", token);
    setToken(token);
    setUser(user);
  }, []);

  const register = useCallback(
    async (username: string, email: string, password: string) => {
      const res = await authApi.register({ username, email, password });
      const { user, token } = res.data;
      localStorage.setItem("steelyard_token", token);
      setToken(token);
      setUser(user);
    },
    []
  );

  const logout = useCallback(() => {
    localStorage.removeItem("steelyard_token");
    setToken(null);
    setUser(null);
  }, []);

  return (
    <AuthContext.Provider value={{ user, token, isLoading, login, register, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
