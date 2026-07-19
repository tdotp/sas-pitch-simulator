import { useState } from "react";
import { APP_USER, APP_PASSWORD } from "../config";

export function Login({ onLogin }: { onLogin: () => void }) {
  const [user, setUser] = useState(APP_USER);
  const [pass, setPass] = useState(APP_PASSWORD);
  const [showPass, setShowPass] = useState(false);
  const [err, setErr] = useState("");

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (user.trim() === APP_USER && pass === APP_PASSWORD) {
      onLogin();
    } else {
      setErr("Usuario o contraseña incorrectos.");
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
              autoComplete="username"
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
          <button className="primary-button primary-button--wide" type="submit">
            Ingresar
          </button>
          {err && <div className="error-text">{err}</div>}
          <button className="text-button" type="button">
            ¿Olvidaste tu contraseña?
          </button>
        </form>
      </div>
    </section>
  );
}
