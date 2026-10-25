/**
 * Getting started › Your machines: the computers already paired, as cards (name · OS · cores ·
 * tunnel), and how this computer connects to another one. Only configured hosts' records count,
 * as in Settings › Machines (any account may publish a record of its own), and never the
 * supervisor's own. Volley cannot find computers on the network yet, so the list is "Computers
 * you've paired".
 *
 * Three ways in, each one Settings › Machines already has: **Pairing code** renders the shared
 * `AddMachineByCode` (`peer_invite`, the `volley peer join` line, waiting for the machine's
 * record, a dry doctor); **SSH key** and **Username and password** render `AddMachineBody`
 * (`machine_add`) with that sign-in chosen. A password is used once, to install this computer's
 * key on the other one, and every later step uses the key (SPEC §4.6.14). The step writes the
 * computers (this one first) and how the last one was connected to the summary.
 */
import "../../styles/machines.css";
import { useEffect, useId, useMemo, useState } from "react";
import { plural } from "../../lib/plural";
import { AddMachineByCode, useNow } from "../../settings/AddMachineByCode";
import { AddMachineBody, type AddMachineFrame } from "../../settings/AddMachineSheet";
import { DAEMON_AGENT_ID } from "../../settings/configTransport";
import { createPeerOps, pairingSupported } from "../../store/peerOps";
import { supervisorHealth } from "../../store/reducer";
import type { MachinePayload } from "../../store/types";
import type { Summary } from "../state";
import type { StepProps } from "../steps";

type ConnectBy = NonNullable<Summary["connectedBy"]>;

const CHOICES: readonly { by: ConnectBy; label: string; what: string; recommended?: true }[] = [
  {
    by: "code",
    label: "Pairing code",
    what: "Run one line on the other computer, type the code shown here. Volley sets up the rest.",
    recommended: true,
  },
  { by: "key", label: "SSH key", what: "Use an SSH key you already have for that computer." },
  {
    by: "password",
    label: "Username and password",
    what: "Sign in once; Volley swaps it for a key and forgets the password.",
  },
];

/** volleyd's `peer_code_ttl_s` default (SPEC §4.6.14), in minutes. */
const CODE_TTL_MIN = 10;
const TICK_MS = 1000;

/** The embedded add-a-machine form: a labelled region in the step instead of a sheet. */
const inline: AddMachineFrame = ({ label, closable, onClose, children }) => (
  <section className="gs-card gs-add" aria-label={label}>
    <div className="gs-add-head">
      <h3 className="gs-card-title">{label}</h3>
      <button type="button" className="gs-link" disabled={!closable} onClick={onClose}>
        Choose another way
      </button>
    </div>
    {children}
  </section>
);

function MachineTile({ m }: { m: MachinePayload }) {
  const up = m.tunnel !== "down";
  return (
    <li>
      <article className="gs-machine" aria-label={m.name}>
        <b className="gs-machine-name">{m.name}</b>
        <span className="dim">
          {m.os} · {plural(m.cores, "core")}
        </span>
        <span className={`hb${up ? "" : " hb--stale"}`}>
          <i />
          tunnel {up ? "up" : "down"}
        </span>
      </article>
    </li>
  );
}

export function Machines({ ctx, setSummary }: StepProps) {
  const id = useId();
  const { state } = ctx;
  const [by, setBy] = useState<ConnectBy>("code");
  /** The way being used now; `null` while the person chooses. */
  const [open, setOpen] = useState<ConnectBy | null>(null);
  const now = useNow(ctx.now, TICK_MS);
  const peerOps = useMemo(() => ctx.peerOps ?? createPeerOps(ctx.ops), [ctx.peerOps, ctx.ops]);

  const local = state.config?.fleet?.local_name ?? undefined;
  const paired = useMemo(() => {
    const hosts = new Set(Object.keys(state.config?.hosts ?? {}));
    return Object.values(state.machines ?? {})
      .filter((m) => m.kind !== "supervisor" && m.name !== local && hosts.has(m.name))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [state.machines, state.config?.hosts, local]);
  const shown = useMemo(() => Object.fromEntries(paired.map((m) => [m.name, m])), [paired]);
  const self =
    local ?? Object.values(state.machines ?? {}).find((m) => m.kind === "supervisor")?.name;
  const names = [...(self ? [self] : []), ...paired.map((m) => m.name)].join(" ");

  useEffect(() => {
    setSummary({ machines: names === "" ? [] : names.split(" ") });
  }, [names, setSummary]);

  const start = () => setOpen(by);
  const close = () => setOpen(null);

  return (
    <>
      <div className="gs-card">
        <h3 className="gs-card-title" id={`${id}-paired`}>
          Computers you've paired
        </h3>
        <ul className="gs-machines" aria-labelledby={`${id}-paired`}>
          {paired.map((m) => (
            <MachineTile key={m.name} m={m} />
          ))}
          <li>
            <button
              type="button"
              className="gs-machine gs-machine--add"
              disabled={open !== null}
              onClick={start}
            >
              + Another computer
            </button>
          </li>
        </ul>
        {paired.length === 0 && (
          <p className="s-hint">None yet: agents run on this computer until you pair another.</p>
        )}
      </div>

      {open === null ? (
        <div className="gs-card">
          <div className="gs-connect" role="radiogroup" aria-labelledby={`${id}-how`}>
            <h3 className="gs-card-title" id={`${id}-how`}>
              How will this computer connect to them?
            </h3>
            {CHOICES.map((c) => (
              <label key={c.by} className={`gs-choice${by === c.by ? " gs-choice--on" : ""}`}>
                <input
                  type="radio"
                  name={`${id}-by`}
                  checked={by === c.by}
                  aria-describedby={`${id}-${c.by}`}
                  onChange={() => setBy(c.by)}
                />
                <span className="gs-choice-text">
                  <b>
                    {c.label}
                    {c.recommended && <span className="chip gs-tag">Recommended</span>}
                  </b>
                  <span id={`${id}-${c.by}`} className="dim">
                    {c.what}
                  </span>
                </span>
              </label>
            ))}
          </div>
          <div className="wiz-actions wiz-actions--inline">
            <button type="button" className="btn btn--hot" onClick={start}>
              Add it
            </button>
          </div>
        </div>
      ) : open === "code" ? (
        <div className="gs-card gs-add">
          <div className="gs-add-head">
            <h3 className="gs-card-title">Pair with a code</h3>
            <button type="button" className="gs-link" onClick={close}>
              Choose another way
            </button>
          </div>
          {pairingSupported() ? (
            <>
              <p className="s-hint">
                The code works once and lives {CODE_TTL_MIN} minutes; make a new one any time.
              </p>
              <AddMachineByCode
                ops={peerOps}
                machines={shown}
                readiness={state.readiness ?? {}}
                config={ctx.config ?? null}
                signIn={ctx.signIn}
                now={now}
                host={ctx.sshHost ?? ""}
                hubUp={!supervisorHealth(state.supervisors[DAEMON_AGENT_ID]).down}
                onClose={close}
                onJoined={() => setSummary({ connectedBy: "code" })}
              />
            </>
          ) : (
            <p className="s-hint">
              This browser cannot make the key that keeps the pairing code private. On this
              computer, <code className="mono">volley peer invite</code> makes a code.
            </p>
          )}
        </div>
      ) : (
        <AddMachineBody
          key={open}
          ops={peerOps}
          initialAuth={open}
          signIn={ctx.signIn}
          frame={inline}
          onClose={close}
          onAdded={() => setSummary({ connectedBy: open })}
        />
      )}
    </>
  );
}
