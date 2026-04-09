import { Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider, useAuth } from "./contexts/AuthContext.tsx";
import { ProtectedRoute } from "./components/ProtectedRoute.tsx";
import LoginPage from "./pages/LoginPage.tsx";
import RegisterPage from "./pages/RegisterPage.tsx";
import SessionViewPage from "./pages/SessionViewPage.tsx";
import Layout from "./components/Layout.tsx";
import OverviewPage from "./pages/OverviewPage.tsx";
import BrowsersPage from "./pages/BrowsersPage.tsx";
import ApiKeyPage from "./pages/ApiKeyPage.tsx";

function AppRoutes() {
  const { registrationEnabled } = useAuth();
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        path="/register"
        element={registrationEnabled ? <RegisterPage /> : <Navigate to="/login" replace />}
      />

      {/* Full-screen session viewer — no sidebar */}
      <Route
        path="/sessions/:id"
        element={
          <ProtectedRoute>
            <SessionViewPage />
          </ProtectedRoute>
        }
      />

      {/* Sidebar layout */}
      <Route
        element={
          <ProtectedRoute>
            <Layout />
          </ProtectedRoute>
        }
      >
        <Route path="/" element={<OverviewPage />} />
        <Route path="/browsers" element={<BrowsersPage />} />
        <Route path="/api-key" element={<ApiKeyPage />} />
        {/* Keep old /sessions URL working */}
        <Route path="/sessions" element={<Navigate to="/browsers" replace />} />
      </Route>
    </Routes>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <AppRoutes />
    </AuthProvider>
  );
}
