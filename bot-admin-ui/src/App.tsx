import { lazy, Suspense } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import BotAdminLayout from "./components/BotAdminLayout";
import ErrorBoundary from "./components/ErrorBoundary";
import LoadingState from "./components/LoadingState";
import ProtectedRoute from "./components/ProtectedRoute";
import { useAuth } from "./hooks/useAuth";
import LoginPage from "./pages/LoginPage";

const UsersPage = lazy(() => import("./pages/UsersPage"));
const OrdersPage = lazy(() => import("./pages/OrdersPage"));
const OrderLogsPage = lazy(() => import("./pages/OrderLogsPage"));
const LogsPage = lazy(() => import("./pages/LogsPage"));
const TicketsPage = lazy(() => import("./pages/TicketsPage"));
const TicketDetailPage = lazy(() => import("./pages/TicketDetailPage"));
const TechnicalSupportPage = lazy(() => import("./pages/TechnicalSupportPage"));
const PricesPage = lazy(() => import("./pages/PricesPage"));
const SettingsPage = lazy(() => import("./pages/SettingsPage"));
const KnowledgePage = lazy(() => import("./pages/KnowledgePage"));
const CustomerAgentPage = lazy(() => import("./pages/CustomerAgentPage"));
const PromptsPage = lazy(() => import("./pages/PromptsPage"));

function SuspensePage({ children }: { children: React.ReactNode }) {
  return (
    <ErrorBoundary>
      <Suspense fallback={<LoadingState />}>{children}</Suspense>
    </ErrorBoundary>
  );
}

function HomeRedirect() {
  const { firstAllowedPath, isLoading } = useAuth();
  if (isLoading) return <LoadingState />;
  if (!firstAllowedPath) {
    return (
      <main className="page page--centered">
        <p className="message error">Нет доступных разделов.</p>
      </main>
    );
  }
  return <Navigate to={firstAllowedPath} replace />;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<ProtectedRoute />}>
        <Route element={<BotAdminLayout />}>
          <Route index element={<HomeRedirect />} />
          <Route element={<ProtectedRoute permission="users_read" />}>
            <Route
              path="users"
              element={
                <SuspensePage>
                  <UsersPage />
                </SuspensePage>
              }
            />
          </Route>
          <Route element={<ProtectedRoute permission="orders_read" />}>
            <Route
              path="orders"
              element={
                <SuspensePage>
                  <OrdersPage />
                </SuspensePage>
              }
            />
          </Route>
          <Route element={<ProtectedRoute permission="order_logs_read" />}>
            <Route
              path="order-logs"
              element={
                <SuspensePage>
                  <OrderLogsPage />
                </SuspensePage>
              }
            />
          </Route>
          <Route element={<ProtectedRoute permission="logs_read" />}>
            <Route
              path="logs"
              element={
                <SuspensePage>
                  <LogsPage />
                </SuspensePage>
              }
            />
          </Route>
          <Route element={<ProtectedRoute permission="tickets_read" />}>
            <Route
              path="tickets"
              element={
                <SuspensePage>
                  <TicketsPage />
                </SuspensePage>
              }
            />
            <Route
              path="tickets/:id"
              element={
                <SuspensePage>
                  <TicketDetailPage />
                </SuspensePage>
              }
            />
          </Route>
          <Route element={<ProtectedRoute permission="technical_support_read" />}>
            <Route
              path="technical-support"
              element={
                <SuspensePage>
                  <TechnicalSupportPage />
                </SuspensePage>
              }
            />
          </Route>
          <Route element={<ProtectedRoute permission="prices_read" />}>
            <Route
              path="prices"
              element={
                <SuspensePage>
                  <PricesPage />
                </SuspensePage>
              }
            />
          </Route>
          <Route element={<ProtectedRoute permission="knowledge_read" />}>
            <Route
              path="knowledge"
              element={
                <SuspensePage>
                  <KnowledgePage />
                </SuspensePage>
              }
            />
          </Route>
          <Route element={<ProtectedRoute permission="ai_customer_test" />}>
            <Route
              path="customer-agent"
              element={
                <SuspensePage>
                  <CustomerAgentPage />
                </SuspensePage>
              }
            />
          </Route>
          <Route element={<ProtectedRoute permission="settings_read" />}>
            <Route
              path="prompts"
              element={
                <SuspensePage>
                  <PromptsPage />
                </SuspensePage>
              }
            />
            <Route
              path="settings"
              element={
                <SuspensePage>
                  <SettingsPage />
                </SuspensePage>
              }
            />
          </Route>
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
