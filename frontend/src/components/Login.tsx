import { useState } from "react";
import { useAuth, authErrorMessage } from "../auth";

export function Login() {
  const { login, resetPassword } = useAuth();
  const [user, setUser] = useState("");
  const [pass, setPass] = useState("");
  const [showPass, setShowPass] = useState(false);
  const [err, setErr] = useState("");
  const [info, setInfo] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr("");
    setInfo("");
    if (!user.trim() || !pass) {
      setErr("Ingresa tu correo y contraseña.");
      return;
    }
    setBusy(true);
    try {
      await login(user, pass);
      // onAuthStateChanged (in AuthProvider) picks up the signed-in user;
      // App.tsx reacts to that and moves past this screen.
    } catch (e) {
      setErr(authErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleForgotPassword() {
    setErr("");
    setInfo("");
    if (!user.trim()) {
      setErr("Escribe tu correo arriba y vuelve a intentar.");
      return;
    }
    setBusy(true);
    try {
      await resetPassword(user);
      setInfo("Si el correo existe, te enviamos un enlace para restablecer la contraseña.");
    } catch (e) {
      setErr(authErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="screen screen--login">
      <header className="brand-header">
        <img className="brand-logo" src="/assets/SmartPR_Logo.svg" alt="SmartPR" />
      </header>

      <div className="login-panel">
        <p className="eyebrow">Acceso privado</p>
        <h1 className="display-title display-title--login">
          Simulador
          <br />
          de vocería
        </h1>
        <p className="lead login-lead">
          Entrena conversaciones ejecutivas en un entorno
          <br />
          privado y recibe retroalimentación al finalizar.
        </p>

        <form className="login-form" onSubmit={submit}>
          <label className="field">
            <span className="sr-only">Correo</span>
            <svg aria-hidden="true" viewBox="0 0 24 24">
              <path d="M3.5 6.5h17v11h-17zM4 7l8 6 8-6" />
            </svg>
            <input
              type="text"
              value={user}
              placeholder="Correo"
              autoComplete="username"
              autoFocus
              onChange={(e) => setUser(e.target.value)}
            />
          </label>
          <label className="field">
            <span className="sr-only">Contraseña</span>
            <svg aria-hidden="true" viewBox="0 0 24 24">
              <path d="M7 10V8a5 5 0 0 1 10 0v2M5 10h14v10H5z" />
            </svg>
            <input
              type={showPass ? "text" : "password"}
              value={pass}
              placeholder="Contraseña"
              autoComplete="current-password"
              onChange={(e) => setPass(e.target.value)}
            />
            <button
              type="button"
              className="field-action"
              aria-label="Mostrar contraseña"
              onClick={() => setShowPass((s) => !s)}
            >
              <svg aria-hidden="true" viewBox="0 0 24 24">
                <path d="M2.5 12s3.5-5 9.5-5 9.5 5 9.5 5-3.5 5-9.5 5-9.5-5-9.5-5z" />
                <circle cx="12" cy="12" r="2.5" />
              </svg>
            </button>
          </label>
          <button className="primary-button primary-button--wide" type="submit" disabled={busy}>
            {busy ? "Ingresando…" : "Ingresar"}
          </button>
          {err && <div className="error-text">{err}</div>}
          {info && <div className="error-text" style={{ color: "inherit" }}>{info}</div>}
          <button
            className="text-button"
            type="button"
            onClick={handleForgotPassword}
            disabled={busy}
          >
            ¿Olvidaste tu contraseña?
          </button>
        </form>
      </div>
    </section>
  );
}
