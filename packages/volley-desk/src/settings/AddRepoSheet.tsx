/**
 * Settings › Repositories' **Add repository…** (SPEC §4.6.21 `repo_add`): the slug, checked as it
 * is typed (`owner/name`, never a URL or `.git`), the machines to add it to (every one checked by
 * default: all of them is `machines: all`, so a machine paired later gets it too) and, per paired
 * machine, an optional existing clone to adopt instead of cloning (`paths`; the supervisor's own
 * clone is always the managed one). **Add** sends one `repo_add`; volleyd checks the slug with
 * GitHub (its refusal is shown as it said it) and answers with the canonical name, then each
 * machine's progress follows its readiness verdict (`cloning…`, `ready`, `blocked: <why>`) until
 * every one is ready or blocked, when **Done** closes. The form's terminal twin (`volley repo add
 * …`) is shown under it.
 */
import { useState } from "react";
import { isRepoSlug } from "../lib/github";
import type { PeerOps } from "../store/peerOps";
import type { ReadinessPayload } from "../store/types";
import { MachineSheet } from "./MachineSheet";
import { addCommand, bySlug, stateText } from "./repos";

export interface AddRepoSheetProps {
  ops: PeerOps;
  /** Every machine, the supervisor's own first (`allMachines`). */
  machines: readonly string[];
  /** The supervisor's own machine: no existing-clone choice there. */
  localName: string | null | undefined;
  /** volleyd's verdicts, by machine: the progress of each machine's clone. */
  readiness: Record<string, ReadinessPayload>;
  onClose: () => void;
}

/** What is wrong with a slug as typed; null for a well-formed `owner/name` (or nothing yet). */
export function slugProblem(value: string): string | null {
  const v = value.trim();
  if (v === "") return null;
  if (
    /^[a-z][a-z0-9+.-]*:\/\//i.test(v) ||
    /^(www\.)?github\.com\//i.test(v) ||
    v.startsWith("git@")
  ) {
    return "Use owner/name, not a URL";
  }
  if (/\.git$/i.test(v)) return "Leave off .git: owner/name";
  // volleyd's own refusal, word for word.
  return isRepoSlug(v) ? null : "slug must be a GitHub <owner/name>";
}

/** What is wrong with an existing clone's path; null when it is absolute (or not typed yet). */
const pathProblem = (v: string): string | null =>
  v.trim() === "" || v.trim().startsWith("/") ? null : "an absolute path, starting with /";

type Phase =
  | { k: "form"; error?: string }
  | { k: "sending" }
  | { k: "added"; slug: string; machines: string[] };

/** A machine's progress has settled: ready, or blocked with its reason. */
const SETTLED: ReadonlySet<string> = new Set(["ready", "blocked"]);

export function AddRepoSheet({ ops, machines, localName, readiness, onClose }: AddRepoSheetProps) {
  const [slug, setSlug] = useState("");
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set(machines));
  /** Per paired machine: adopt an existing clone, and its path. */
  const [adopt, setAdopt] = useState<Record<string, { on: boolean; path: string }>>({});
  const [phase, setPhase] = useState<Phase>({ k: "form" });

  const chosen = machines.filter((m) => picked.has(m));
  const all = chosen.length === machines.length;
  const paths = Object.fromEntries(
    chosen.flatMap((m) => {
      const a = adopt[m];
      return a?.on && a.path.trim() ? [[m, a.path.trim()]] : [];
    }),
  );
  const problem = slugProblem(slug);
  // A ticked existing clone needs its path: left empty, the machine would quietly clone instead.
  const pathBad = chosen.some((m) => {
    const p = adopt[m]?.on ? adopt[m]?.path.trim() : undefined;
    return p !== undefined && (p === "" || pathProblem(p) !== null);
  });
  const valid = slug.trim() !== "" && problem === null && chosen.length > 0 && !pathBad;

  const toggle = (m: string) =>
    setPicked((s) => {
      const next = new Set(s);
      if (next.has(m)) next.delete(m);
      else next.add(m);
      return next;
    });

  const add = async () => {
    setPhase({ k: "sending" });
    const s = slug.trim();
    const target = all ? ("all" as const) : chosen;
    const r = await ops.repoAdd(
      s,
      Object.keys(paths).length > 0 ? { machines: target, paths } : { machines: target },
    );
    setPhase(
      r.ok
        ? { k: "added", slug: r.slug, machines: r.machines.length > 0 ? r.machines : chosen }
        : { k: "form", error: r.error },
    );
  };

  if (phase.k === "added") {
    const states = phase.machines.map((m) => {
      const v = bySlug(readiness[m]?.repos, phase.slug);
      return { m, state: v?.state, text: stateText(v ?? { reasons: [] }, "starting…") };
    });
    const settled = states.every((x) => x.state !== undefined && SETTLED.has(x.state));
    return (
      <MachineSheet label="Add repository" onClose={onClose}>
        <p>
          Added <b className="mono">{phase.slug}</b>. Each machine clones it and trusts it for
          Claude Code:
        </p>
        <ul className="repo-chips" aria-label={`Progress for ${phase.slug}`}>
          {states.map(({ m, state, text }) => (
            <li
              key={m}
              className={`repo-chip repo-chip--${state ?? "none"}`}
              aria-label={`${m}: ${text}`}
            >
              <b>{m}</b>
              <span className="ell">{text}</span>
              {(state === undefined || state === "cloning") && (
                <span className="spinner" aria-hidden="true" />
              )}
            </li>
          ))}
        </ul>
        {states.some((x) => x.state === "blocked") && (
          <p className="s-hint">
            A blocked machine is tried again when it is back, or after Repair on its row.
          </p>
        )}
        <div className="ny-actions">
          <button type="button" className="btn btn--hot" disabled={!settled} onClick={onClose}>
            Done
          </button>
        </div>
      </MachineSheet>
    );
  }

  return (
    <MachineSheet label="Add repository" onClose={onClose}>
      <label className="repo-field">
        <span className="s-hint">Repository (owner/name)</span>
        <input
          className="recessed mono"
          aria-label="Repository (owner/name)"
          placeholder="example-org/example-repo"
          autoComplete="off"
          spellCheck={false}
          value={slug}
          aria-invalid={problem !== null}
          onChange={(e) => {
            setSlug(e.target.value);
            if (phase.k === "form" && phase.error) setPhase({ k: "form" });
          }}
        />
      </label>
      {problem && <p className="s-error">{problem}</p>}
      <fieldset className="repo-machines">
        <legend className="s-hint">Machines</legend>
        {machines.map((m) => {
          const a = adopt[m] ?? { on: false, path: "" };
          const paired = m !== localName;
          const bad = a.on ? pathProblem(a.path) : null;
          return (
            <div key={m} className="repo-machine">
              <label>
                <input type="checkbox" checked={picked.has(m)} onChange={() => toggle(m)} />
                {m}
              </label>
              {!paired && <span className="chip chip--mine">this one</span>}
              {paired && picked.has(m) && (
                <label className="s-hint">
                  <input
                    type="checkbox"
                    aria-label={`Use an existing clone on ${m}`}
                    checked={a.on}
                    onChange={() => setAdopt((x) => ({ ...x, [m]: { ...a, on: !a.on } }))}
                  />
                  use an existing clone
                </label>
              )}
              {paired && picked.has(m) && a.on && (
                <>
                  <input
                    className="recessed mono"
                    aria-label={`Existing clone on ${m}`}
                    placeholder="/path/to/clone"
                    value={a.path}
                    onChange={(e) =>
                      setAdopt((x) => ({ ...x, [m]: { ...a, path: e.target.value } }))
                    }
                  />
                  {bad && <span className="s-error">{bad}</span>}
                </>
              )}
            </div>
          );
        })}
      </fieldset>
      {phase.k === "form" && phase.error && (
        <p className="s-error" role="alert">
          {phase.error}
        </p>
      )}
      <p className="s-foot">
        From a terminal:{" "}
        <code className="mono">{addCommand(slug.trim(), all ? "all" : chosen, paths)}</code>
      </p>
      <div className="ny-actions">
        <button type="button" className="btn" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="btn btn--hot"
          disabled={!valid || phase.k === "sending"}
          onClick={() => void add()}
        >
          {phase.k === "sending" ? "Adding…" : "Add"}
        </button>
      </div>
    </MachineSheet>
  );
}
