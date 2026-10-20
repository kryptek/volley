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
 *
 * The look (D9) is the prototype `signin.tsx`: Line Waves behind a deep glass
 * card that tilts toward the pointer, recessed fields and a Specular Button.
 * After a submit the card stays up, busy, until the first connect settles
 * (connected, or disconnected: the Desk then shows its own offline state).
 *
 * A one-time link (`<desk>#signin=<token>`, from a sign-in link or the admin
 * token `volley auth token` prints) skips the form: the token leaves the
 * address bar at once (it is single use), the card says it is signing in with
 * the link, and `redeemToken` trades it with volleyd for an account bound to
 * "Desk on <device>" (SPEC §4.6.10). The minted credential is stored like a
 * typed one, with its role; an admin token also asks the Desk to open
 * Settings › Setup & Security once. A used or expired link shows the form
 * with the reason and what to do next.
 */
import {
  type CSSProperties,
  type FormEvent,
  type PointerEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import SpecularButton from "../rb/SpecularButton/SpecularButton";
import {
  CREDENTIALS_STORAGE_KEY,
  DeskStoreProvider,
  readCredentials,
  resolveBrokerUrl,
  useDesk,
  viteEnv,
} from "../store/context";
import {
  type RedeemRequest,
  type RedeemResult,
  deviceLabel,
  markFirstRun,
  redeemToken,
  signinTokenFromHash,
} from "../store/control";
import { isDemoMode } from "../store/fixtures";
import type { BrokerCredentials, DeskMqttClient } from "../store/mqtt-client";
import { Clawd } from "../windows/wave/Clawd";
import { PHONE, REDUCED_MOTION, SignInBackdrop, useMedia } from "./SignInBackdrop";
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

/** A stored sign-in: the credentials, and the role and label when a redeemed token told them. */
type StoredSignIn = BrokerCredentials & { role?: string; label?: string };

function writeStored(storage: Storage0 | null, creds: StoredSignIn | null): void {
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
  /** Redeems a `#signin=<token>` link (tests inject one); default `redeemToken`. */
  redeem?: (req: RedeemRequest) => Promise<RedeemResult>;
}

/** Strip the fragment (the single-use token) from the address bar and the history entry. */
function dropFragment(): void {
  try {
    const { pathname, search } = window.location;
    window.history.replaceState(window.history.state, "", `${pathname}${search}`);
  } catch {
    // No history API: the token is burned on use anyway.
  }
}

export function SignInGate({
  children,
  demo: demoProp,
  env: envProp,
  brokerUrl,
  clientFactory,
  settleMs,
  redeem = redeemToken,
}: SignInGateProps) {
  const env = envProp ?? viteEnv();
  const demo = demoProp ?? isDemoMode(window.location.search, env);
  const [storage] = useState(localStorageOrNull);
  /** The one-time token in the address bar, read once (the effect below drops it from there). */
  const [link] = useState(() => (demo ? null : signinTokenFromHash(window.location.hash)));
  const [creds, setCreds] = useState<BrokerCredentials | null>(() =>
    demo || link !== null ? null : (readCredentials(env, null) ?? readStored(storage)),
  );
  const [lastUsername, setLastUsername] = useState(
    () => creds?.username ?? readStored(storage)?.username ?? "desk",
  );
  const [error, setError] = useState<string | null>(null);
  /** A submitted sign-in whose first connect hasn't settled yet. */
  const [pending, setPending] = useState(false);
  /** The link is being redeemed. */
  const [redeeming, setRedeeming] = useState(link !== null);
  /** A token is single use: redeem it once, even when an effect runs twice. */
  const started = useRef(false);
  const passthrough = {
    ...(brokerUrl !== undefined ? { brokerUrl } : {}),
    ...(clientFactory !== undefined ? { clientFactory } : {}),
    ...(settleMs !== undefined ? { settleMs } : {}),
  };

  const url = resolveBrokerUrl(brokerUrl);
  useEffect(() => {
    if (link === null || started.current) return;
    started.current = true;
    dropFragment();
    void redeem({ url, token: link, label: deviceLabel(navigator.userAgent) }).then((r) => {
      setRedeeming(false);
      if (!r.ok) {
        setError(
          `This sign-in link did not work: ${r.error}. Ask for a new link (Settings › Setup & Security on a signed-in Desk, or \`volley auth signin-link\` in a terminal), or sign in below.`,
        );
        return;
      }
      const next = { username: r.username, password: r.password };
      writeStored(storage, {
        ...next,
        ...(r.role !== null ? { role: r.role } : {}),
        label: r.label,
      });
      if (r.role === "admin") markFirstRun();
      setLastUsername(r.username);
      setError(null);
      setPending(true);
      setCreds(next);
    });
  }, [link, redeem, storage, url]);

  if (demo) {
    return (
      <DeskStoreProvider demo {...passthrough}>
        {children}
      </DeskStoreProvider>
    );
  }
  // The backdrop keeps its slot from the form to the busy card, so Line Waves isn't remounted.
  return (
    <>
      {(creds === null || pending) && <SignInBackdrop />}
      {redeeming ? (
        <SignInCard
          brokerUrl={url}
          initialUsername=""
          initialPassword=""
          error={null}
          busy
          link
          onError={() => {}}
          onSubmit={() => {}}
        />
      ) : creds === null ? (
        <SignInCard
          brokerUrl={url}
          initialUsername={lastUsername}
          initialPassword=""
          error={error}
          onError={setError}
          onSubmit={(next) => {
            writeStored(storage, next);
            setLastUsername(next.username);
            setError(null);
            setPending(true);
            setCreds(next);
          }}
        />
      ) : (
        <DeskStoreProvider
          demo={false}
          auth={creds.username !== "" ? creds : null}
          onAuthFailed={(message) => {
            writeStored(storage, null);
            setLastUsername(creds.username);
            setError(`The broker refused the sign-in: ${message}`);
            setPending(false);
            setCreds(null);
          }}
          {...passthrough}
        >
          {pending ? (
            <Connecting onSettled={() => setPending(false)}>
              <SignInCard
                brokerUrl={url}
                initialUsername={creds.username}
                initialPassword={creds.password}
                error={null}
                busy
                onError={() => {}}
                onSubmit={() => {}}
              />
            </Connecting>
          ) : (
            children
          )}
        </DeskStoreProvider>
      )}
    </>
  );
}

/**
 * The sign-in screen as a new browser or phone sees it (Settings › Setup &
 * Security › Preview): the same backdrop and card, signing nothing in.
 */
export function SignInPreview({ brokerUrl, onClose }: { brokerUrl: string; onClose: () => void }) {
  const [note, setNote] = useState<string | null>(null);
  return (
    <div
      className="signin-preview"
      // biome-ignore lint/a11y/useSemanticElements: a full-screen overlay, as the real sign-in is
      role="dialog"
      aria-modal="true"
      aria-label="Sign-in screen preview"
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }}
    >
      <SignInBackdrop />
      <SignInCard
        brokerUrl={brokerUrl}
        initialUsername="desk"
        initialPassword=""
        error={note}
        onError={setNote}
        onSubmit={() => setNote("This is a preview: nothing was signed in.")}
      />
      <button
        type="button"
        className="btn signin-preview-close"
        // biome-ignore lint/a11y/noAutofocus: the overlay takes focus so Escape closes it
        autoFocus
        onClick={onClose}
      >
        Close preview
      </button>
    </div>
  );
}

/** Shows `children` (the busy card) until the first connect leaves `connecting`. */
function Connecting({ children, onSettled }: { children: ReactNode; onSettled: () => void }) {
  const { connection } = useDesk();
  useEffect(() => {
    if (connection !== "connecting") onSettled();
  }, [connection, onSettled]);
  return <>{children}</>;
}

const NO_TILT = { x: 0, y: 0 };

function SignInCard({
  brokerUrl,
  initialUsername,
  initialPassword,
  error,
  busy = false,
  link = false,
  onError,
  onSubmit,
}: {
  brokerUrl: string;
  initialUsername: string;
  initialPassword: string;
  error: string | null;
  busy?: boolean;
  /** Signing in with a one-time link: no fields, just what is happening. */
  link?: boolean;
  onError: (message: string) => void;
  onSubmit: (creds: BrokerCredentials) => void;
}) {
  const [username, setUsername] = useState(initialUsername);
  const [password, setPassword] = useState(initialPassword);
  const [tilt, setTilt] = useState(NO_TILT);
  const reduced = useMedia(REDUCED_MOTION);
  const phone = useMedia(PHONE);
  const still = reduced || phone;
  const move = (e: PointerEvent<HTMLDivElement>) => {
    if (still) return;
    const r = e.currentTarget.querySelector(".signin-card")?.getBoundingClientRect();
    if (!r) return;
    const nx = (e.clientX - (r.left + r.width / 2)) / window.innerWidth;
    const ny = (e.clientY - (r.top + r.height / 2)) / window.innerHeight;
    setTilt({ x: Math.max(-1, Math.min(1, nx * 2)), y: Math.max(-1, Math.min(1, ny * 2)) });
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const name = username.trim();
    if (name !== "" && !AGENT_ID.test(name)) {
      onError(`'${name}' is not a valid agent id: use lowercase letters, digits, _ and -`);
      return;
    }
    onSubmit({ username: name, password: name === "" ? "" : password });
  };
  const tiltVars = {
    "--rx": `${(-tilt.y * 5).toFixed(2)}deg`,
    "--ry": `${(tilt.x * 7).toFixed(2)}deg`,
    "--gx": `${50 + tilt.x * 30}%`,
    "--gy": `${30 + tilt.y * 25}%`,
  } as CSSProperties;
  return (
    <div className="signin-screen" onPointerMove={move} onPointerLeave={() => setTilt(NO_TILT)}>
      <div className="signin-card" style={tiltVars}>
        <div className="signin-sheen" aria-hidden />
        <div className="signin-brand">
          <span aria-hidden>
            <Clawd size={30} />
          </span>
          <div>
            <h1 className="signin-word">
              volley <span>desk</span>
            </h1>
            <div className="signin-sub">Sign in to your broker</div>
          </div>
        </div>
        <form className="signin-form" aria-label="Sign in to the broker" onSubmit={submit}>
          <div className="signin-broker" data-state={busy ? "busy" : "idle"}>
            <i className="dot" aria-hidden />
            {brokerUrl}
          </div>
          {link ? (
            <output className="signin-hint">Signing in with your one-time link…</output>
          ) : (
            <>
              <label className="f3d">
                <span>Username</span>
                <input
                  autoComplete="username"
                  autoCapitalize="none"
                  spellCheck={false}
                  value={username}
                  readOnly={busy}
                  onChange={(e) => setUsername(e.target.value)}
                />
              </label>
              <label className="f3d">
                <span>Password</span>
                <input
                  type="password"
                  autoComplete="current-password"
                  placeholder="••••••••••"
                  value={password}
                  readOnly={busy}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </label>
            </>
          )}
          {error !== null && (
            <div className="signin-err" role="alert">
              {error}
            </div>
          )}
          <div className={`spec-wrap${busy ? " is-busy" : ""}`}>
            <SpecularButton
              type="submit"
              size="lg"
              disabled={busy}
              className="spec-signin"
              tint="#7c6cf6"
              tintOpacity={0.32}
              baseColor="#2a1f6e"
              lineColor="#d6f7ff"
              textColor="#ffffff"
              intensity={1.15}
              idleIntensity={0.35}
              glow={0.9}
              thickness={1.4}
              followMouse
              autoAnimate
            >
              {busy ? "Signing in…" : "Sign in"}
            </SpecularButton>
          </div>
          {!link && (
            <p className="signin-hint">
              Use the account from Setup or Settings → Broker accounts, or open a sign-in link.
              Leave the username empty to watch read-only.
            </p>
          )}
        </form>
      </div>
    </div>
  );
}
