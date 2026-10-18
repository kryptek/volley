/**
 * LoginGate — asks for broker credentials before the dashboard connects.
 *
 * The broker requires authentication (examples/mosquitto-auth/), so the
 * browser signs in as the `desk` identity minted by `volley auth init`.
 * Credentials live in localStorage (per browser profile, survives reloads);
 * a broker refusal (AUTH_FAILED) forgets the password and shows the form
 * again with the broker's reason. An empty username connects anonymously,
 * for brokers that still allow it.
 *
 * localStorage is readable by any script on this origin; that is the same
 * trust boundary as the dashboard itself, which already holds the session.
 */
import { type FormEvent, useState } from "react";
import type { BrokerCredentials } from "../lib/mqtt-client";
import { resolveBrokerUrl } from "../state/dashboard-context";
import { Dashboard, type DashboardProps } from "./Dashboard";

export const CREDENTIALS_STORAGE_KEY = "volley-dash:broker-auth";

function readStored(): BrokerCredentials | null {
  try {
    const raw = localStorage.getItem(CREDENTIALS_STORAGE_KEY);
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as Partial<BrokerCredentials>;
    if (typeof parsed.username !== "string" || typeof parsed.password !== "string") return null;
    return { username: parsed.username, password: parsed.password };
  } catch {
    return null;
  }
}

function writeStored(creds: BrokerCredentials | null): void {
  try {
    if (creds === null) localStorage.removeItem(CREDENTIALS_STORAGE_KEY);
    else localStorage.setItem(CREDENTIALS_STORAGE_KEY, JSON.stringify(creds));
  } catch {
    // Storage blocked (private mode): the session still works until reload.
  }
}

export type LoginGateProps = Pick<DashboardProps, "brokerUrl" | "clientFactory">;

export function LoginGate({ brokerUrl, clientFactory }: LoginGateProps = {}): JSX.Element {
  const [creds, setCreds] = useState<BrokerCredentials | null>(readStored);
  const [lastUsername, setLastUsername] = useState(creds?.username ?? "");
  const [error, setError] = useState<string | null>(null);

  if (creds === null) {
    return (
      <LoginForm
        brokerUrl={resolveBrokerUrl(brokerUrl)}
        initialUsername={lastUsername}
        error={error}
        onSubmit={(next) => {
          writeStored(next);
          setLastUsername(next.username);
          setError(null);
          setCreds(next);
        }}
      />
    );
  }

  return (
    <Dashboard
      brokerUrl={brokerUrl}
      clientFactory={clientFactory}
      auth={creds.username !== "" ? creds : undefined}
      onAuthFailed={(message) => {
        writeStored(null);
        setError(message);
        setCreds(null);
      }}
    />
  );
}

interface LoginFormProps {
  brokerUrl: string;
  initialUsername: string;
  error: string | null;
  onSubmit: (creds: BrokerCredentials) => void;
}

function LoginForm({ brokerUrl, initialUsername, error, onSubmit }: LoginFormProps): JSX.Element {
  const [username, setUsername] = useState(initialUsername);
  const [password, setPassword] = useState("");

  const submit = (e: FormEvent): void => {
    e.preventDefault();
    onSubmit({ username: username.trim(), password });
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-bg px-4 font-mono text-fg">
      <form
        data-testid="login-form"
        onSubmit={submit}
        className="flex w-full max-w-sm flex-col gap-3 rounded-md border border-line bg-surface p-6"
      >
        <h1 className="text-sm font-semibold">Sign in to the broker</h1>
        <div className="text-xs text-fg-3">{brokerUrl}</div>
        {error !== null && (
          <div role="alert" className="rounded border border-line px-3 py-2 text-xs text-st-failed">
            {error}
          </div>
        )}
        <label className="flex flex-col gap-1 text-xs text-fg-2">
          Username
          <input
            className="rounded border border-line bg-bg-2 px-2 py-1.5 text-sm text-fg"
            autoComplete="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-fg-2">
          Password
          <input
            className="rounded border border-line bg-bg-2 px-2 py-1.5 text-sm text-fg"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        <button
          type="submit"
          className="mt-1 rounded border border-line-hi bg-surface-2 px-3 py-1.5 text-sm text-fg hover:bg-surface-hi"
        >
          Connect
        </button>
        <p className="text-xs text-fg-4">
          Use the <code>desk</code> identity from <code>volley auth init</code>. Leave the username
          empty for a broker that allows anonymous access. Stored in this browser&apos;s
          localStorage.
        </p>
      </form>
    </div>
  );
}
