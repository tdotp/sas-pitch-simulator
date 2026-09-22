// Phase 1 auth context: wraps Firebase Auth's email/password sign-in,
// persists the session across reloads, and exposes login/logout/reset plus
// a way to fetch the current ID token for API calls.
//
// This intentionally does NOT expose a signup/register function — Phase 1
// scope is Login, Logout and Password Reset only. Accounts are created out
// -of-band (Admin SDK bootstrap), not from the frontend.
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  onAuthStateChanged,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signOut,
  type User,
} from "firebase/auth";
import { auth } from "./firebase";

interface AuthState {
  user: User | null;
  loading: boolean; // true until the initial auth state is known
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  resetPassword: (email: string) => Promise<void>;
  /** Current ID token. Pass forceRefresh=true after a 401 to retry once. */
  getIdToken: (forceRefresh?: boolean) => Promise<string | null>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const userRef = useRef<User | null>(null);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => {
      userRef.current = u;
      setUser(u);
      setLoading(false);
    });
    return unsub;
  }, []);

  async function login(email: string, password: string) {
    await signInWithEmailAndPassword(auth, email.trim(), password);
  }

  async function logout() {
    await signOut(auth);
  }

  async function resetPassword(email: string) {
    await sendPasswordResetEmail(auth, email.trim());
  }

  async function getIdToken(forceRefresh = false): Promise<string | null> {
    const current = userRef.current ?? auth.currentUser;
    if (!current) return null;
    return current.getIdToken(forceRefresh);
  }

  return (
    <AuthContext.Provider
      value={{ user, loading, login, logout, resetPassword, getIdToken }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth debe usarse dentro de <AuthProvider>");
  return ctx;
}

// Human-readable mapping for the Firebase Auth error codes we can hit here.
export function authErrorMessage(err: unknown): string {
  const code = (err as { code?: string })?.code ?? "";
  switch (code) {
    case "auth/invalid-email":
      return "Correo inválido.";
    case "auth/invalid-credential":
    case "auth/wrong-password":
    case "auth/user-not-found":
      return "Correo o contraseña incorrectos.";
    case "auth/too-many-requests":
      return "Demasiados intentos. Espera un momento e intenta de nuevo.";
    case "auth/network-request-failed":
      return "No se pudo conectar. Revisa tu conexión.";
    default:
      return "No pudimos iniciar sesión. Intenta de nuevo.";
  }
}
