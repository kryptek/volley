/**
 * Settings › Machines › **Add a bare machine…** (SPEC §4.6.14 `machine_add`):
 * a box with nothing on it but ssh becomes a ready paired machine without a
 * terminal. The form takes its address (`user@host`), how volleyd's first ssh
 * signs in (its password, or a key file on the supervisor's machine) and,
 * optionally, its sudo password, used only when the box lacks git or tmux (the
 * run announces it first), and a name. volleyd runs `volley machine add`'s seven
 * steps over ssh and publishes each line as it happens: the sheet lists every
 * step, pending until reached, with its lines under it. The run ends with the
 * machine's readiness (its doctor checks, each failing one with the card's fix,
 * GitHub's included) and the remote Claude sign-in button the cards have; a
 * failure names the step and its fix, and Back returns to the form.
 *
 * The passwords are masked, go to volleyd only (its admin channel, which no
 * other account reads), and are dropped from the form once a run starts: a
 * retry asks for them again. The sheet cannot be closed while a run is going.
 */
import { type ReactNode, useId, useState } from "react";
import type { MachineAddAnswer, MachineAddRequest, PeerOps } from "../store/peerOps";
import type { MachineAddRow } from "../store/types";
import { CheckRows } from "./MachineRows";
import { MachineSheet } from "./MachineSheet";

/** `volley machine add`'s steps, in order (volley-cli's machine/add.ts). */
const STEPS = ["ssh", "Volley", "Setup", "ssh back", "Pairing", "Sign-ins", "Doctor"] as const;

const ADDRESS_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]*@[A-Za-z0-9_][A-Za-z0-9_.-]*$/;
const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;

/** An ssh destination volleyd takes for a box: `user@host`, never an option. */
export const isBoxAddress = (v: string): boolean => ADDRESS_RE.test(v);

type Phase =
  | { k: "form"; error?: string }
  | { k: "running" }
  | { k: "done"; answer: Extract<MachineAddAnswer, { ok: true }> }
  | { k: "failed"; error: string };

interface StepView {
  title: string;
  state: "pending" | "running" | "ok" | "failed";
  lines: string[];
}

/** Every step, with the rows that arrived: a step before the latest is done. */
function stepViews(rows: readonly MachineAddRow[], ended: boolean): StepView[] {
  const latest = rows.reduce((n, r) => Math.max(n, r.step), 0);
  return STEPS.map((title, i) => {
    const n = i + 1;
    const mine = rows.filter((r) => r.step === n);
    const failed = mine.some((r) => r.state === "failed");
    return {
      title: mine[0]?.title ?? title,
      state: failed
        ? "failed"
        : n < latest || (ended && n === latest)
          ? "ok"
          : n === latest
            ? "running"
            : "pending",
      lines: mine.flatMap((r) => (r.line ? [r.line] : [])),
    };
  });
}

const GLYPH: Record<StepView["state"], string> = {
  pending: "·",
  running: "…",
  ok: "✓",
  failed: "✗",
};

export function AddMachineSheet({
  ops,
  onClose,
  signIn,
}: {
  ops: PeerOps;
  onClose: () => void;
  /** The Machines window's remote Claude sign-in button for a machine. */
  signIn?: ((machine: string) => ReactNode) | undefined;
}) {
  const id = useId();
  const [address, setAddress] = useState("");
  const [how, setHow] = useState<"password" | "key">("password");
  const [password, setPassword] = useState("");
  const [key, setKey] = useState("");
  const [sudo, setSudo] = useState("");
  const [name, setName] = useState("");
  const [tried, setTried] = useState(false);
  const [phase, setPhase] = useState<Phase>({ k: "form" });
  const [rows, setRows] = useState<MachineAddRow[]>([]);

  const addr = address.trim();
  const problem =
    addr === "" || !isBoxAddress(addr)
      ? "The address must be user@host, the account volleyd signs in to over ssh."
      : how === "password" && password === ""
        ? "Give the box's password, or choose Key file."
        : how === "key" && !key.trim().startsWith("/")
          ? "The key file must be an absolute path on the supervisor's machine."
          : name.trim() !== "" && !NAME_RE.test(name.trim())
            ? "The name must be lower-case letters, digits, - or _ (at most 63)."
            : null;
  const addrBad = tried && (addr === "" || !isBoxAddress(addr));

  const start = async () => {
    setTried(true);
    if (problem !== null) return;
    const req: MachineAddRequest = {
      address: addr,
      ...(how === "key" ? { key: key.trim() } : { password }),
      ...(sudo !== "" ? { sudo } : {}),
      ...(name.trim() !== "" ? { name: name.trim() } : {}),
    };
    // Never kept past the run: a retry asks again.
    setPassword("");
    setSudo("");
    setRows([]);
    setPhase({ k: "running" });
    const a = await ops.machineAdd(req, (r) => setRows((rs) => [...rs, r]));
    setPhase(a.ok ? { k: "done", answer: a } : { k: "failed", error: a.error });
  };

  const running = phase.k === "running";
  const label = phase.k === "done" ? `Add ${phase.answer.name}` : "Add a bare machine";

  if (phase.k === "form") {
    return (
      <MachineSheet label={label} onClose={onClose}>
        <p className="dim">
          A box with ssh and nothing else (macOS or Ubuntu/Debian): volleyd installs Volley there,
          pairs it and checks it, as <code className="mono">volley machine add</code> does.
        </p>
        <form
          className="m-add-form"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void start();
          }}
        >
          <label htmlFor={`${id}-address`}>Address</label>
          <input
            id={`${id}-address`}
            className="recessed mono"
            placeholder="dev@box-a.lan"
            autoComplete="off"
            spellCheck={false}
            value={address}
            aria-invalid={addrBad}
            onChange={(e) => setAddress(e.target.value)}
          />
          <fieldset className="m-add-how">
            <legend>Sign in with</legend>
            <label>
              <input
                type="radio"
                name={`${id}-how`}
                checked={how === "password"}
                onChange={() => setHow("password")}
              />
              Password
            </label>
            <label>
              <input
                type="radio"
                name={`${id}-how`}
                checked={how === "key"}
                onChange={() => setHow("key")}
              />
              Key file
            </label>
          </fieldset>
          {how === "password" ? (
            <>
              <label htmlFor={`${id}-password`}>Password</label>
              <input
                id={`${id}-password`}
                className="recessed"
                type="password"
                autoComplete="off"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </>
          ) : (
            <>
              <label htmlFor={`${id}-key`}>Key file path</label>
              <input
                id={`${id}-key`}
                className="recessed mono"
                placeholder="/path/to/home/.ssh/id_ed25519"
                autoComplete="off"
                spellCheck={false}
                value={key}
                onChange={(e) => setKey(e.target.value)}
              />
            </>
          )}
          <label htmlFor={`${id}-sudo`}>Sudo password (optional)</label>
          <input
            id={`${id}-sudo`}
            className="recessed"
            type="password"
            autoComplete="off"
            aria-describedby={`${id}-sudo-hint`}
            value={sudo}
            onChange={(e) => setSudo(e.target.value)}
          />
          <p id={`${id}-sudo-hint`} className="s-hint m-add-hint">
            Used only when the box lacks git or tmux (or curl, gh): the run says so before it uses
            sudo.
          </p>
          <label htmlFor={`${id}-name`}>Name (optional)</label>
          <input
            id={`${id}-name`}
            className="recessed mono"
            placeholder={defaultName(addr) || "box-a"}
            autoComplete="off"
            spellCheck={false}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          {((tried && problem) || phase.error) && (
            <p className="s-error m-add-hint" role="alert">
              {phase.error ?? problem}
            </p>
          )}
          <div className="ny-actions m-add-hint">
            <button type="submit" className="btn btn--hot">
              {addr ? `Add ${addr}` : "Add"}
            </button>
            <button type="button" className="btn" onClick={onClose}>
              Cancel
            </button>
          </div>
        </form>
      </MachineSheet>
    );
  }

  const views = stepViews(rows, phase.k !== "running");
  return (
    <MachineSheet label={label} onClose={onClose} closable={!running}>
      <div aria-live="polite">
        <ol className="m-add-steps" aria-label="Steps">
          {views.map((v, i) => (
            <li
              key={STEPS[i]}
              className={`m-add-step m-add-step--${v.state}`}
              data-state={v.state}
              aria-label={`${i + 1}. ${v.title}: ${v.state}`}
            >
              <span className="m-glyph" aria-hidden="true">
                {v.state === "running" ? <span className="spinner" /> : GLYPH[v.state]}
              </span>
              <b>{v.title}</b>
              {v.lines.length > 0 && (
                <ul className="m-add-lines mono">
                  {v.lines.map((l, j) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: a step's lines only grow
                    <li key={j}>{l}</li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ol>
      </div>
      {phase.k === "failed" && (
        <>
          <p className="s-error" role="alert">
            {phase.error}
          </p>
          <div className="ny-actions">
            <button type="button" className="btn btn--hot" onClick={() => setPhase({ k: "form" })}>
              Back
            </button>
          </div>
        </>
      )}
      {phase.k === "done" && <Ready answer={phase.answer} signIn={signIn} onClose={onClose} />}
    </MachineSheet>
  );
}

/** The run's end: the machine's readiness card and its sign-ins. */
function Ready({
  answer,
  signIn,
  onClose,
}: {
  answer: Extract<MachineAddAnswer, { ok: true }>;
  signIn?: ((machine: string) => ReactNode) | undefined;
  onClose: () => void;
}) {
  const { name } = answer;
  return (
    <section className="m-add-ready" aria-label={`${name} readiness`}>
      <h3>{answer.ready ? `${name} is ready for agents` : `${name} is not ready yet`}</h3>
      {answer.checks.length > 0 && (
        <CheckRows checks={answer.checks} ctx={{ machine: name }} label={`Checks on ${name}`} />
      )}
      {!answer.signin.claude && signIn?.(name)}
      <div className="ny-actions">
        <button type="button" className="btn btn--hot" onClick={onClose}>
          Done
        </button>
      </div>
    </section>
  );
}

/** The host's short name, as volleyd defaults it. */
function defaultName(address: string): string {
  const host = address.slice(address.lastIndexOf("@") + 1);
  return (host.split(".")[0] ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .slice(0, 63);
}
