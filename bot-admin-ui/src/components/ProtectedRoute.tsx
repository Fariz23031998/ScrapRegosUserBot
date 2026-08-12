import { Navigate, Outlet, useLocation, useOutletContext } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";
import LoadingState from "./LoadingState";

export type ProtectedRouteProps = {
  permission?: string;
};

export default function ProtectedRoute({ permission }: ProtectedRouteProps) {
  const { isAuthenticated, isLoading, hasPermission, firstAllowedPath } = useAuth();
  const location = useLocation();
  const outletContext = useOutletContext();

  if (isLoading) {
    return <LoadingState message="Загрузка…" />;
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  if (permission && !hasPermission(permission)) {
    const fallback = firstAllowedPath;
    if (fallback && fallback !== location.pathname) {
      return <Navigate to={fallback} replace />;
    }
    return (
      <main className="page page--centered">
        <p className="message error">Нет доступа к этому разделу.</p>
      </main>
    );
  }

  return <Outlet context={outletContext} />;
}
