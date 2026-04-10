import { Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider, useAuth } from "./contexts/AuthContext.tsx";
import { AdminRoute, ProtectedRoute } from "./components/ProtectedRoute.tsx";
import LoginPage from "./pages/LoginPage.tsx";
import RegisterPage from "./pages/RegisterPage.tsx";
import SessionViewPage from "./pages/SessionViewPage.tsx";
import Layout from "./components/Layout.tsx";
import OverviewPage from "./pages/OverviewPage.tsx";
import BrowsersPage from "./pages/BrowsersPage.tsx";
import AdminUsersPage from "./pages/AdminUsersPage.tsx";
import AdminSessionsPage from "./pages/AdminSessionsPage.tsx";

function AppRoutes() {
  const { registrationEnabled } = useAuth();

  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        path="/register"
        element={registrationEnabled ? <RegisterPage /> : <Navigate to="/login" replace />}
      />

      <Route
        path="/sessions/:id"
        element={
          <ProtectedRoute>
            <SessionViewPage />
          </ProtectedRoute>
        }
      />

      <Route
        element={
          <ProtectedRoute>
            <Layout />
          </ProtectedRoute>
        }
      >
        <Route path="/" element={<OverviewPage />} />
        <Route path="/browsers" element={<BrowsersPage />} />
        <Route
          path="/admin/users"
          element={
            <AdminRoute>
              <AdminUsersPage />
            </AdminRoute>
          }
        />
        <Route
          path="/admin/sessions"
          element={
            <AdminRoute>
              <AdminSessionsPage />
            </AdminRoute>
          }
        />
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
