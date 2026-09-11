import { createContext, useContext, useState, useEffect, type ReactNode } from "react";
import { useTrackStackAuth } from "trackstack-ui";
import { API_BASE } from "@/lib/api";
import { setAuthTokenGetter } from "@workspace/api-client-react";

// Identity (registration, login, Google OAuth) is owned by trackstack-auth,
// not this app's own backend -- login/register/logout/token storage are
// delegated to trackstack-ui's shared useTrackStackAuth (previously
// hand-rolled here independently; see workspace-notes/ACTION_ITEMS.md's
// cross-repo duplication scan, 2026-09-10, for why). /me still calls this
// app's own API (kept locally -- see routes/auth.ts) to fetch this app's
// view of the current user's profile without an extra network hop --
// that verification-on-mount layer is finance-specific and stays here,
// not pushed into the shared hook.
const TRACKSTACK_AUTH_URL = import.meta.env.VITE_TRACKSTACK_AUTH_URL ?? "";

interface User {
  id: number;
  email: string;
  name: string | null;
}

interface AuthContextType {
  user: User | null;
  token: string | null;
  isLoading: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string, name?: string) => Promise<void>;
  loginWithGoogle: (returnTo?: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextType | null>(null);

const TOKEN_KEY = "auth_token";

export function AuthProvider({ children }: { children: ReactNode }) {
  const auth = useTrackStackAuth({ tokenKey: TOKEN_KEY, authBaseUrl: TRACKSTACK_AUTH_URL });
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // Set the auth token getter for the generated API client
  useEffect(() => {
    setAuthTokenGetter(() => auth.token);
  }, [auth.token]);

  // Verify token on mount -- deliberately still a mount-only check (empty
  // deps, same as before this migration), not re-run on every auth.token
  // change: login()/register() below already populate `user` directly
  // from the response's `account`, so re-verifying via /me on that same
  // token change would just be a redundant round-trip.
  //
  // When there's no local token, try single sign-on before giving up and
  // showing the login page: trackstack-auth's own session cookie may
  // already authenticate this browser (e.g. the user logged into a
  // DIFFERENT TrackStack app earlier). auth.trySilentSSO()'s response
  // already carries `account`, same shape as login()/register()'s, so
  // this sets `user` directly rather than following up with a redundant
  // /me call.
  useEffect(() => {
    const token = auth.token;
    if (token) {
      fetch(`${API_BASE}/api/auth/me`, {
        headers: { Authorization: `Bearer ${token}` },
      })
        .then((res) => {
          if (!res.ok) throw new Error("Invalid token");
          return res.json();
        })
        .then(setUser)
        .catch(() => {
          auth.logout();
          setUser(null);
        })
        .finally(() => setIsLoading(false));
      return;
    }

    auth
      .trySilentSSO()
      .then((result) => {
        if (result) setUser(result.account);
      })
      .finally(() => setIsLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const login = async (email: string, password: string) => {
    const { account } = await auth.login(email, password);
    setUser(account);
  };

  const register = async (email: string, password: string, name?: string) => {
    const { account } = await auth.register(email, password, name);
    setUser(account);
  };

  const logout = () => {
    auth.logout();
    setUser(null);
  };

  return (
    <AuthContext.Provider
      value={{ user, token: auth.token, isLoading, login, register, loginWithGoogle: auth.loginWithGoogle, logout }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
