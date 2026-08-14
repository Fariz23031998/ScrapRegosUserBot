import { Eye, EyeOff } from "lucide-react";
import { useEffect, useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { login } from "../api/auth";
import { useAuth } from "../hooks/useAuth";

export default function LoginPage() {
  const navigate = useNavigate();
  const { isAuthenticated, isLoading, refreshSession, firstAllowedPath } = useAuth();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  const landingPath = firstAllowedPath || "/";

  useEffect(() => {
    if (!isLoading && isAuthenticated) {
      navigate(landingPath, { replace: true });
    }
  }, [isAuthenticated, isLoading, landingPath, navigate]);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setBusy(true);
    const form = new FormData(event.currentTarget);
    try {
      await login(String(form.get("login") || ""), String(form.get("password") || ""));
      await refreshSession();
      navigate("/", { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось войти");
    } finally {
      setBusy(false);
    }
  }

  if (isLoading) return null;
  if (isAuthenticated) return <Navigate to={landingPath} replace />;

  return (
    <div className="login-page">
      <main className="page login-card">
        <h1>Вход в Bot Admin</h1>
        <p>Используйте логин и пароль администратора или сотрудника.</p>
        <form className="stack-form" onSubmit={handleSubmit}>
          <label>
            Логин
            <input name="login" autoComplete="username" required />
          </label>
          <label>
            Пароль
            <div className="password-field">
              <input
                name="password"
                type={showPassword ? "text" : "password"}
                autoComplete="current-password"
                required
              />
              <button
                type="button"
                className="password-field__toggle"
                onClick={() => setShowPassword((v) => !v)}
                aria-label={showPassword ? "Скрыть пароль" : "Показать пароль"}
                title={showPassword ? "Скрыть пароль" : "Показать пароль"}
              >
                {showPassword ? <EyeOff size={18} aria-hidden="true" /> : <Eye size={18} aria-hidden="true" />}
              </button>
            </div>
          </label>
          {error ? <p className="message error">{error}</p> : null}
          <button type="submit" className="btn-primary" disabled={busy}>
            Войти
          </button>
        </form>
      </main>
    </div>
  );
}
