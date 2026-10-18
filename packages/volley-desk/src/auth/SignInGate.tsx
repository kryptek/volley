/**
 * The Desk's sign-in, ported from the legacy dashboard's `LoginGate`: asks
 * for broker credentials before the store connects. The broker requires
 * authentication (`examples/mosquitto-auth/`), so the browser signs in as the
 * `desk` identity minted by `volley auth init`.
 *
 * Credentials live in localStorage under `volley-desk:broker-auth` (per
 * browser profile, survives reloads). A broker refusal (AUTH_FAILED) forgets
 * the password and shows the form again with the broker's reason and the
 * username filled in. An empty username connects anonymously (read-only), for
 * brokers that still allow it. The dev-only `VITE_VOLLEY_BROKER_*` variables
 * skip the form; demo mode never asks.
 *
 * localStorage is readable by any script on this origin; that is the same
 * trust boundary as the Desk itself, which holds the session.
 */
import { type FormEvent, type ReactNode, useState } from "react";
import {
  CREDENTIALS_STORAGE_KEY,
  DeskStoreProvider,
  readCredentials,
  resolveBrokerUrl,
  viteEnv,
} from "../store/context";
import { isDemoMode } from "../store/fixtures";
import type { BrokerCredentials, DeskMqttClient } from "../store/mqtt-client";
import "../styles/signin.css";

/** The agent-id grammar (SPEC §2.2): the username signs every envelope and names the Desk's mailbox. */
const AGENT_ID = /^[a-z0-9][a-z0-9_-]{0,62}$/;

type Storage0 = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function localStorageOrNull(): Storage0 | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** The stored sign-in, an empty username meaning anonymous; `null` when there is none. */
function readStored(storage: Storage0 | null): BrokerCredentials | null {
  try {
    const raw = storage?.getItem(CREDENTIALS_STORAGE_KEY);
    if (!raw) return null;
    const c = JSON.parse(raw) as Partial<BrokerCredentials>;
    if (typeof c.username !== "string" || typeof c.password !== "string") return null;
    if (c.username !== "" && !AGENT_ID.test(c.username)) return null;
    return { username: c.username, password: c.password };
  } catch {
    return null;
  }
}

function writeStored(storage: Storage0 | null, creds: BrokerCredentials | null): void {
  try {
    if (creds === null) storage?.removeItem(CREDENTIALS_STORAGE_KEY);
    else storage?.setItem(CREDENTIALS_STORAGE_KEY, JSON.stringify(creds));
  } catch {
    // Storage blocked (private mode): the session still works until reload.
  }
}

export interface SignInGateProps {
  children: ReactNode;
  /** Default: `?demo=1` / `VITE_VOLLEY_DEMO`. */
  demo?: boolean;
  /** Vite's env (tests inject one). */
  env?: Record<string, unknown>;
  brokerUrl?: string;
  clientFactory?: (url: string, auth?: BrokerCredentials) => DeskMqttClient;
  settleMs?: number;
}

export function SignInGate({
  children,
  demo: demoProp,
  env: envProp,
  brokerUrl,
  clientFactory,
  settleMs,
}: SignInGateProps) {
  const env = envProp ?? viteEnv();
  const demo = demoProp ?? isDemoMode(window.location.search, env);
  const [storage] = useState(localStorageOrNull);
  const [creds, setCreds] = useState<BrokerCredentials | null>(() =>
    demo ? null : (readCredentials(env, null) ?? readStored(storage)),
  );
  const [lastUsername, setLastUsername] = useState(creds?.username ?? "desk");
  const [error, setError] = useState<string | null>(null);
  const passthrough = {
    ...(brokerUrl !== undefined ? { brokerUrl } : {}),
    ...(clientFactory !== undefined ? { clientFactory } : {}),
    ...(settleMs !== undefined ? { settleMs } : {}),
  };

  if (demo) {
    return (
      <DeskStoreProvider demo {...passthrough}>
        {children}
      </DeskStoreProvider>
    );
  }
  if (creds === null) {
    return (
      <SignInForm
        brokerUrl={resolveBrokerUrl(brokerUrl)}
        initialUsername={lastUsername}
        error={error}
        onError={setError}
        onSubmit={(next) => {
          writeStored(storage, next);
          setLastUsername(next.username);
          setError(null);
          setCreds(next);
        }}
      />
    );
  }
  return (
    <DeskStoreProvider
      demo={false}
      auth={creds.username !== "" ? creds : null}
      onAuthFailed={(message) => {
        writeStored(storage, null);
        setLastUsername(creds.username);
        setError(`The broker refused the sign-in: ${message}`);
        setCreds(null);
      }}
      {...passthrough}
    >
      {children}
    </DeskStoreProvider>
  );
}

function SignInForm({
  brokerUrl,
  initialUsername,
  error,
  onError,
  onSubmit,
}: {
  brokerUrl: string;
  initialUsername: string;
  error: string | null;
  onError: (message: string) => void;
  onSubmit: (creds: BrokerCredentials) => void;
}) {
  const [username, setUsername] = useState(initialUsername);
  const [password, setPassword] = useState("");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const name = username.trim();
    if (name !== "" && !AGENT_ID.test(name)) {
      onError(`'${name}' is not a valid agent id: use lowercase letters, digits, _ and -`);
      return;
    }
    onSubmit({ username: name, password: name === "" ? "" : password });
  };
  return (
    <div className="signin-scrim">
      <form className="signin" aria-label="Sign in to the broker" onSubmit={submit}>
        <h1 className="signin-title">Sign in to the broker</h1>
        <div className="mono dim">{brokerUrl}</div>
        {error !== null && (
          <div className="signin-error" role="alert">
            {error}
          </div>
        )}
        <label className="field">
          <span>Username</span>
          <input
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
        </label>
        <label className="field">
          <span>Password</span>
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        <button type="submit" className="btn btn--hot">
          Sign in
        </button>
        <p className="signin-note dim">
          Use the <code>desk</code> identity from <code>volley auth init</code>. Leave the username
          empty for a broker that allows anonymous access (read-only). Stored in this browser's
          localStorage.
        </p>
      </form>
    </div>
  );
}
