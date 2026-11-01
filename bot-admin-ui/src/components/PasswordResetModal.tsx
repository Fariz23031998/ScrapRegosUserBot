import { useEffect, useState } from "react";
import { confirmPasswordReset, requestPasswordReset } from "../api/auth";
import Modal from "./Modal";

type PasswordResetModalProps = {
  open: boolean;
  onClose: () => void;
  onSaved: (message: string) => void;
};

export default function PasswordResetModal({ open, onClose, onSaved }: PasswordResetModalProps) {
  const [step, setStep] = useState<"login" | "code">("login");
  const [login, setLogin] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [passwordRepeat, setPasswordRepeat] = useState("");
  const [info, setInfo] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) return;
    setStep("login");
    setLogin("");
    setCode("");
    setPassword("");
    setPasswordRepeat("");
    setInfo("");
    setError("");
    setBusy(false);
  }, [open]);

  async function sendCode(event?: React.FormEvent) {
    event?.preventDefault();
    setError("");
    setBusy(true);
    try {
      const result = await requestPasswordReset(login.trim());
      setInfo(result.message);
      setStep("code");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось отправить код");
    } finally {
      setBusy(false);
    }
  }

  async function savePassword(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    if (password !== passwordRepeat) {
      setError("Пароли не совпадают.");
      return;
    }
    setBusy(true);
    try {
      const result = await confirmPasswordReset(login.trim(), code.trim(), password);
      onSaved(result.message);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось сохранить пароль");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} title="Восстановить или задать пароль" onClose={onClose}>
      {step === "login" ? (
        <form className="stack-form" onSubmit={(event) => void sendCode(event)}>
          <p className="login-hint">
            Код придёт в Telegram, если этот логин или телефон привязан к боту.
          </p>
          <label>
            Логин или телефон
            <input
              name="login"
              value={login}
              autoComplete="username"
              placeholder="Логин или номер телефона"
              required
              onChange={(event) => setLogin(event.target.value)}
            />
          </label>
          {error ? <p className="message error">{error}</p> : null}
          <button type="submit" className="btn-primary" disabled={busy}>
            Отправить код
          </button>
        </form>
      ) : (
        <form className="stack-form" onSubmit={(event) => void savePassword(event)}>
          {info ? <p className="login-hint">{info}</p> : null}
          <label>
            Код из Telegram
            <input
              name="code"
              value={code}
              inputMode="numeric"
              autoComplete="one-time-code"
              required
              onChange={(event) => setCode(event.target.value)}
            />
          </label>
          <label>
            Новый пароль
            <input
              name="password"
              type="password"
              value={password}
              autoComplete="new-password"
              required
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
          <label>
            Повторите пароль
            <input
              name="password_repeat"
              type="password"
              value={passwordRepeat}
              autoComplete="new-password"
              required
              onChange={(event) => setPasswordRepeat(event.target.value)}
            />
          </label>
          {error ? <p className="message error">{error}</p> : null}
          <button type="button" className="btn-text" onClick={() => void sendCode()} disabled={busy}>
            Отправить код ещё раз
          </button>
          <div className="form-actions">
            <button
              type="button"
              className="btn-secondary"
              onClick={() => {
                setError("");
                setStep("login");
              }}
              disabled={busy}
            >
              Назад
            </button>
            <button type="submit" className="btn-primary" disabled={busy}>
              Сохранить пароль
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}
