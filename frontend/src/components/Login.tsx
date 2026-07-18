import { useState } from "react";
import { APP_USER, APP_PASSWORD } from "../config";

export function Login({ onLogin }: { onLogin: () => void }) {
  const [user, setUser] = useState("");
  const [pass, setPass] = useState("");
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
    <div className="login-wrap">
      <form className="card login-card" onSubmit={submit}>
        <div className="logo-big">SAS</div>
        <p className="muted" style={{ marginTop: 4 }}>
          Simulador de Vocería C-level
        </p>
        <input
          type="text"
          placeholder="Usuario"
          value={user}
          autoFocus
          onChange={(e) => setUser(e.target.value)}
        />
        <input
          type="password"
          placeholder="Contraseña"
          value={pass}
          onChange={(e) => setPass(e.target.value)}
        />
        <button className="btn btn-primary" type="submit">
          Ingresar
        </button>
        {err && <div className="error">{err}</div>}
      </form>
    </div>
  );
}
