/**
 * The add-a-repository form (SPEC §4.6.21 `repo_add`) that Settings › Repositories' **Add
 * repository…** sheet and Getting started › Repos share: the slug, checked as it is typed
 * (`owner/name`, never a URL or `.git`), the machines to add it to (every one checked by default:
 * all of them is `machines: all`, so a machine paired later gets it too) and, per paired machine,
 * an optional existing clone to adopt instead of cloning (`paths`; the supervisor's own clone is
 * always the managed one). **Add** sends one `repo_add`; volleyd checks the slug with GitHub (its
 * refusal is shown as it said it) and answers with the canonical name, handed to `onAdded`. The
 * form's terminal twin (`volley repo add …`) is shown under it.
 *
 * While **Add** is off the form says why, next to it (`addBlocker`). An existing clone's path is
 * checked on its machine as it is typed (`repo_probe`, `useCloneProbes`): no folder there, not a
 * git clone, or a clone of another repository keeps Add off; a clone of a GitHub repository fills
 * an empty owner/name the person has not typed in.
 */
import { useEffect, useRef, useState } from "react";
import { isRepoSlug } from "../lib/github";
import type { PeerOps, RepoAddResult, RepoProbeResult } from "../store/peerOps";
import { addCommand, sameSlug } from "./repos";

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
export const pathProblem = (v: string): string | null =>
  v.trim() === "" || v.trim().startsWith("/") ? null : "an absolute path, starting with /";

/** A path's check on one machine: the path it was asked about, and the answer (null: in flight). */
export interface CloneCheck {
  path: string;
  result: RepoProbeResult | null;
}

/** What `addBlocker` reads: the form as it stands. */
export interface AddForm {
  slug: string;
  /** The machines picked. */
  machines: readonly string[];
  localName: string | null | undefined;
  adopt: Readonly<Record<string, { on: boolean; path: string }>>;
  checks: Readonly<Record<string, CloneCheck>>;
}

/** How long after a path last changed it is checked on its machine. */
export const PROBE_DEBOUNCE_MS = 500;

/** `path` is the clone's own root (`rev-parse --show-toplevel`), not a folder inside one. */
export const isRoot = (path: string, root: string | undefined) =>
  root === undefined || path.replace(/\/+$/, "") === root.replace(/\/+$/, "");

/** A check's finding that keeps Add off; null when it lets the add go ahead. */
export function probeProblem(
  m: string,
  path: string,
  slug: string,
  r: RepoProbeResult,
): string | null {
  if (!r.ok) return null; // The box may be down: volleyd's run will say.
  if (r.state === "missing") return `No folder at ${path} on ${m}`;
  if (r.state === "not_git") return `${path} on ${m} is not a git clone`;
  if (r.state === "found" && !isRoot(path, r.root))
    return `${path} on ${m} is inside the clone at ${r.root}`;
  if (r.state === "found" && r.slug !== undefined && !sameSlug(r.slug, slug))
    return `This clone is ${r.slug}, not ${slug}`;
  return null;
}

/** Why Add is off, the first reason only; null when the form can be sent. */
export function addBlocker(form: AddForm): string | null {
  const slug = form.slug.trim();
  if (slug === "") return "Enter owner/name";
  const bad = slugProblem(slug);
  if (bad !== null) return bad;
  if (form.machines.length === 0) return "Pick at least one machine";
  for (const m of form.machines) {
    const a = form.adopt[m];
    if (m === form.localName || !a?.on) continue;
    const path = a.path.trim();
    if (path === "") return `Enter the clone's path on ${m}`;
    const wrong = pathProblem(path);
    if (wrong !== null) return wrong;
    const check = form.checks[m];
    if (check?.path !== path || check.result === null) return `Checking ${path} on ${m}…`;
    const found = probeProblem(m, path, slug, check.result);
    if (found !== null) return found;
  }
  return null;
}

/**
 * Each wanted `machine → path` checked on its machine (`repo_probe`), `PROBE_DEBOUNCE_MS` after
 * it last changed. An answer for a path since changed (or unticked) is dropped.
 */
export function useCloneProbes(
  ops: PeerOps,
  wanted: Readonly<Record<string, string>>,
): Record<string, CloneCheck> {
  const [checks, setChecks] = useState<Record<string, CloneCheck>>({});
  const latest = useRef(wanted);
  latest.current = wanted;
  const held = useRef(checks);
  held.current = checks;
  const key = Object.entries(wanted)
    .map(([m, p]) => `${m}\u0000${p}`)
    .sort()
    .join("\n");
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` is `wanted`, by value
  useEffect(() => {
    const now = latest.current;
    setChecks((c) => {
      const kept = Object.fromEntries(Object.entries(c).filter(([m, ch]) => now[m] === ch.path));
      return Object.keys(kept).length === Object.keys(c).length ? c : kept;
    });
    const timers = Object.entries(now)
      .filter(([m, path]) => held.current[m]?.path !== path)
      .map(([m, path]) =>
        setTimeout(() => {
          setChecks((c) => ({ ...c, [m]: { path, result: null } }));
          void ops.repoProbe(m, path).then((result) => {
            if (latest.current[m] !== path) return;
            setChecks((c) => (c[m]?.path === path ? { ...c, [m]: { path, result } } : c));
          });
        }, PROBE_DEBOUNCE_MS),
      );
    return () => {
      for (const t of timers) clearTimeout(t);
    };
  }, [key, ops]);
  return checks;
}

const UNTICK = 'Untick "use an existing clone" to clone it there instead';

/** What a check found, under the path it checked. */
function CloneFinding({ m, check, slug }: { m: string; check: CloneCheck; slug: string }) {
  const r = check.result;
  if (r === null) return null;
  if (!r.ok) return <span className="s-hint">{`Could not check ${m}: ${r.error}`}</span>;
  if (r.state === "no_origin")
    return <span className="s-hint">{`${check.path} on ${m} has no origin remote`}</span>;
  const problem = probeProblem(m, check.path, slug.trim() || (r.slug ?? ""), r);
  if (problem !== null) {
    return (
      <>
        <span className="s-error">{problem}</span>
        {r.state !== "found" && <span className="s-hint">{UNTICK}</span>}
      </>
    );
  }
  return r.slug ? <span className="s-hint">{`Clone of ${r.slug}`}</span> : null;
}

/** volleyd's answer to an add that went through. */
export type RepoAdded = Extract<RepoAddResult, { ok: true }>;

export interface AddRepoFormProps {
  ops: PeerOps;
  /** Every machine, the supervisor's own first (`allMachines`). */
  machines: readonly string[];
  /** The supervisor's own machine: no existing-clone choice there. */
  localName: string | null | undefined;
  /** volleyd added it: its answer, and the machines picked. */
  onAdded(added: RepoAdded, picked: string[]): void;
  /** A Cancel button beside Add (the sheet's). */
  onCancel?: () => void;
  /** The machines' legend (default "Machines"). */
  machinesLabel?: string;
  /** Add's label (default "Add"). */
  submitLabel?: string;
}

export function AddRepoForm({
  ops,
  machines,
  localName,
  onAdded,
  onCancel,
  machinesLabel = "Machines",
  submitLabel = "Add",
}: AddRepoFormProps) {
  const [slug, setSlug] = useState("");
  /** The machines unticked: one that is listed later (the config landing) starts ticked. */
  const [dropped, setDropped] = useState<ReadonlySet<string>>(() => new Set());
  const picked = new Set(machines.filter((m) => !dropped.has(m)));
  /** Per paired machine: adopt an existing clone, and its path. */
  const [adopt, setAdopt] = useState<Record<string, { on: boolean; path: string }>>({});
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The person typed in owner/name: a clone's slug never fills it after that. */
  const touched = useRef(false);

  const chosen = machines.filter((m) => picked.has(m));
  const all = chosen.length === machines.length;
  const paths = Object.fromEntries(
    chosen.flatMap((m) => {
      const a = adopt[m];
      return a?.on && a.path.trim() ? [[m, a.path.trim()]] : [];
    }),
  );
  const problem = slugProblem(slug);
  // Every ticked clone's path that could be one, checked on its machine.
  const wanted = Object.fromEntries(
    chosen.flatMap((m) => {
      const p = adopt[m]?.on && m !== localName ? adopt[m]?.path.trim() : undefined;
      return p && pathProblem(p) === null ? [[m, p]] : [];
    }),
  );
  const checks = useCloneProbes(ops, wanted);
  // A ticked existing clone needs its path: left empty, the machine would quietly clone instead.
  const blocker = addBlocker({ slug, machines: chosen, localName, adopt, checks });

  // A clone of a GitHub repository names it: fill an owner/name nobody has typed in.
  useEffect(() => {
    if (touched.current || slug !== "") return;
    const found = Object.values(checks).find(
      (c) => c.result?.ok && c.result.slug !== undefined && isRoot(c.path, c.result.root),
    );
    if (found?.result?.ok && found.result.slug) setSlug(found.result.slug);
  }, [checks, slug]);

  const toggle = (m: string) =>
    setDropped((s) => {
      const next = new Set(s);
      if (next.has(m)) next.delete(m);
      else next.add(m);
      return next;
    });

  const add = async () => {
    setSending(true);
    const s = slug.trim();
    const target = all ? ("all" as const) : chosen;
    const r = await ops.repoAdd(
      s,
      Object.keys(paths).length > 0 ? { machines: target, paths } : { machines: target },
    );
    setSending(false);
    if (r.ok) onAdded(r, chosen);
    else setError(r.error);
  };

  return (
    <>
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
            touched.current = true;
            setSlug(e.target.value);
            setError(null);
          }}
        />
      </label>
      {problem && <p className="s-error">{problem}</p>}
      <fieldset className="repo-machines">
        <legend className="s-hint">{machinesLabel}</legend>
        {machines.map((m) => {
          const a = adopt[m] ?? { on: false, path: "" };
          const paired = m !== localName;
          const bad = a.on ? pathProblem(a.path) : null;
          const check = checks[m];
          const checked = check !== undefined && check.path === a.path.trim() ? check : undefined;
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
                  {checked && <CloneFinding m={m} check={checked} slug={slug} />}
                </>
              )}
            </div>
          );
        })}
      </fieldset>
      {error && (
        <p className="s-error" role="alert">
          {error}
        </p>
      )}
      <p className="s-foot">
        From a terminal:{" "}
        <code className="mono">{addCommand(slug.trim(), all ? "all" : chosen, paths)}</code>
      </p>
      <div className="ny-actions">
        {onCancel && (
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
        )}
        <button
          type="button"
          className="btn btn--hot"
          disabled={blocker !== null || sending}
          onClick={() => void add()}
        >
          {sending ? "Adding…" : submitLabel}
        </button>
      </div>
      {blocker !== null && <output className="s-hint repo-blocker">{blocker}</output>}
    </>
  );
}
