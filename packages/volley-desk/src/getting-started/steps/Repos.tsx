/**
 * Getting started › Repos: GitHub on the supervisor's machine, then the repositories waves run in.
 *
 * The GitHub card reads the supervisor's own record (`auth.gh`, SPEC §4.6.15): `ok` or `no_write`
 * is signed in, `unauthenticated` or `missing` is not, and then the card shows the command to run
 * in a terminal on that machine (volleyd has no op that signs gh in) and **Check again**, which
 * waits for the machine's next record. No login name is shown: the record carries none.
 *
 * Add a repo has two tabs, both ending in one `repo_add` (§4.6.21): **From GitHub** is Settings ›
 * Repositories' form (`AddRepoForm`: an `owner/name` and the machines to clone it on), and **A
 * folder on a computer** is a paired machine and a folder there, read with `repo_probe` as it is
 * typed (the debounced `useCloneProbes`): a clone of a GitHub repository fills the slug, and no
 * folder, not a git clone or no origin keeps Add off. The supervisor's own machine cannot be
 * probed (volleyd refuses it), so its clones stay a path in the wave file. Each repository added is
 * listed under the form with what GitHub said of it, and goes into the summary's `repos`.
 */
import { useEffect, useId, useMemo, useState } from "react";
import { GooeyTabs, tabPanelProps } from "../../look/GooeyTabs";
import {
  AddRepoForm,
  type CloneCheck,
  type RepoAdded,
  addBlocker,
  isRoot,
  pathProblem,
  probeProblem,
  useCloneProbes,
} from "../../settings/AddRepoForm";
import { CopyText } from "../../settings/onboardingParts";
import { allMachines, sameSlug } from "../../settings/repos";
import { readSessionRole } from "../../store/control";
import { type PeerOps, createPeerOps } from "../../store/peerOps";
import type { MachinePayload } from "../../store/types";
import type { StepProps } from "../steps";

/** What to run in a terminal on the supervisor's machine to sign gh in (and git through it). */
export const GH_SIGNIN_COMMAND = "gh auth login --web --git-protocol https && gh auth setup-git";

type Tab = "github" | "folder";
const TABS = [
  { key: "github", label: "From GitHub" },
  { key: "folder", label: "A folder on a computer" },
] as const;

/** The supervisor's record: by its configured name, else the record that says it is one. */
function supervisorRecord(p: StepProps): MachinePayload | undefined {
  const records = p.ctx.state.machines ?? {};
  const local = p.ctx.state.config?.fleet?.local_name;
  return (local ? records[local] : undefined) ?? Object.values(records).find(isSupervisor);
}
const isSupervisor = (m: MachinePayload) => m.kind === "supervisor";

/** What GitHub said of an added repository: its line under the form. */
const foundLine = (r: RepoAdded) =>
  r.visibility ? `✓ Found on GitHub · ${r.visibility}` : "✓ Found on GitHub";

export function Repos(p: StepProps) {
  const { ctx, summary, setSummary } = p;
  const ops = useMemo(
    () => createPeerOps(ctx.ops, { role: readSessionRole(ctx.ops.identity) }),
    [ctx.ops],
  );
  const record = supervisorRecord(p);
  const local = ctx.state.config?.fleet?.local_name ?? record?.name ?? null;
  const every = allMachines(ctx.state.config);
  const machines = every.length > 0 ? every : local ? [local] : [];
  const paired = machines.filter((m) => m !== local);
  const [tab, setTab] = useState<Tab>("github");
  /** What GitHub said of each repository added here, by slug. */
  const [found, setFound] = useState<Record<string, string>>({});
  /** Remounts the form once an add went through, so it starts empty. */
  const [round, setRound] = useState(0);
  const tabsId = useId();

  /** The summary's repos, then any added here that it does not hold yet. */
  const listed = [
    ...summary.repos,
    ...Object.keys(found).filter((s) => !summary.repos.some((r) => sameSlug(r, s))),
  ];
  const added = (r: RepoAdded) => {
    setFound((f) => ({ ...f, [r.slug]: foundLine(r) }));
    setRound((n) => n + 1);
    if (!listed.some((s) => sameSlug(s, r.slug))) setSummary({ repos: [...listed, r.slug] });
  };

  return (
    <>
      <GitHubCard record={record} name={local} />
      <div className="gs-card">
        <h3 className="gs-card-title">Add a repo</h3>
        <GooeyTabs
          id={tabsId}
          label="Add a repo from"
          tabs={TABS}
          value={tab}
          onChange={setTab}
          accent="#7c8cff"
        />
        <div className="gs-repo-form" {...tabPanelProps(tabsId, tab)}>
          {tab === "github" ? (
            <AddRepoForm
              key={round}
              ops={ops}
              machines={machines}
              localName={local}
              machinesLabel="Clone it on"
              submitLabel="Add repo"
              onAdded={added}
            />
          ) : (
            <FolderForm key={round} ops={ops} paired={paired} local={local} onAdded={added} />
          )}
        </div>
        {listed.length > 0 && (
          <ul className="gs-repos" aria-label="Repos added">
            {listed.map((s) => (
              <li key={s}>
                <b className="mono">{s}</b>
                {found[s] && <span className="gs-ok">{found[s]}</span>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

/** gh on the supervisor's machine, from its record; the command and Check again when signed out. */
function GitHubCard({ record, name }: { record: MachinePayload | undefined; name: string | null }) {
  const machine = name ?? "the supervisor's machine";
  const gh = record?.auth?.gh;
  const signedIn = gh === "ok" || gh === "no_write";
  /** The record's `last_seen` when Check again was pressed: waiting until a newer one lands. */
  const [waitingFrom, setWaitingFrom] = useState<string | null>(null);
  const waiting = waitingFrom !== null && record?.last_seen === waitingFrom;
  const titleId = useId();
  return (
    <section className="gs-card" aria-labelledby={titleId}>
      <h3 className="gs-card-title" id={titleId}>
        GitHub
      </h3>
      {signedIn ? (
        <p className="gs-ok">{`✓ Signed in on ${machine}`}</p>
      ) : (
        <>
          <p className="gs-status-line">
            <b>{gh === undefined ? "Not checked yet" : "Not signed in"}</b>
          </p>
          <p className="dim">{`Run this in a terminal on ${machine}, then Check again:`}</p>
          <CopyText text={GH_SIGNIN_COMMAND} />
          <div className="gs-row">
            <button
              type="button"
              className="btn btn--sm"
              disabled={waiting}
              onClick={() => setWaitingFrom(record?.last_seen ?? "")}
            >
              Check again
            </button>
            {waiting && <output className="dim">{`Waiting for ${machine}'s next check…`}</output>}
          </div>
        </>
      )}
    </section>
  );
}

/** A folder on a paired machine: probed as it is typed, the slug filled from its origin. */
function FolderForm({
  ops,
  paired,
  local,
  onAdded,
}: {
  ops: PeerOps;
  paired: readonly string[];
  local: string | null;
  onAdded(r: RepoAdded): void;
}) {
  const [machine, setMachine] = useState(paired[0] ?? "");
  const [path, setPath] = useState("");
  const [slug, setSlug] = useState("");
  /** The slug came from the folder's origin, not from the person. */
  const [filled, setFilled] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const folder = path.trim();
  const wanted = machine && folder && pathProblem(folder) === null ? { [machine]: folder } : {};
  const checks = useCloneProbes(ops, wanted);
  const check = checks[machine]?.path === folder ? checks[machine] : undefined;
  const r = check?.result ?? undefined;
  const fromOrigin = r?.ok && r.state === "found" && isRoot(folder, r.root) ? r.slug : undefined;
  // A clone of a GitHub repository names it: fill an owner/name the person has not typed.
  useEffect(() => {
    if (!fromOrigin || (slug !== "" && !filled) || slug === fromOrigin) return;
    setSlug(fromOrigin);
    setFilled(true);
  }, [fromOrigin, slug, filled]);
  const noOrigin =
    r?.ok && r.state === "no_origin" ? `${folder} on ${machine} has no origin remote` : null;
  const blocker = paired.includes(machine)
    ? (addBlocker({
        slug,
        machines: [machine],
        localName: local,
        adopt: { [machine]: { on: true, path } },
        checks,
      }) ?? noOrigin)
    : "Pick a computer";
  const note = local
    ? `${local}'s own clones are added by path in the wave file, as today.`
    : "The supervisor's own clones are added by path in the wave file, as today.";

  if (paired.length === 0) {
    return (
      <>
        <p className="dim">
          No computer is paired yet: pair one in Your machines, or add the repo From GitHub.
        </p>
        <p className="s-hint">{note}</p>
      </>
    );
  }

  const add = async () => {
    setSending(true);
    const res = await ops.repoAdd(slug.trim(), {
      machines: [machine],
      paths: { [machine]: folder },
    });
    setSending(false);
    if (res.ok) onAdded(res);
    else setError(res.error);
  };

  return (
    <>
      <div className="gs-folder">
        <label className="repo-field">
          <span className="s-hint">Computer</span>
          <select
            className="recessed"
            aria-label="Computer"
            value={machine}
            onChange={(e) => setMachine(e.target.value)}
          >
            {paired.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>
        <label className="repo-field gs-grow">
          <span className="s-hint">Folder</span>
          <input
            className="recessed mono"
            aria-label="Folder"
            placeholder="/path/to/clone"
            autoComplete="off"
            spellCheck={false}
            value={path}
            onChange={(e) => {
              setPath(e.target.value);
              setError(null);
            }}
          />
        </label>
      </div>
      <FolderLine folder={folder} machine={machine} check={check} filled={filled} slug={slug} />
      <label className="repo-field">
        <span className="s-hint">Repository (owner/name)</span>
        <input
          className="recessed mono"
          aria-label="Repository (owner/name)"
          placeholder="example-org/example-repo"
          autoComplete="off"
          spellCheck={false}
          value={slug}
          onChange={(e) => {
            setSlug(e.target.value);
            setFilled(false);
            setError(null);
          }}
        />
      </label>
      {error && (
        <p className="s-error" role="alert">
          {error}
        </p>
      )}
      <p className="s-hint">{note}</p>
      <div className="ny-actions">
        <button
          type="button"
          className="btn btn--hot"
          disabled={blocker !== null || sending}
          onClick={() => void add()}
        >
          {sending ? "Adding…" : "Add repo"}
        </button>
      </div>
      {blocker !== null && <output className="s-hint repo-blocker">{blocker}</output>}
    </>
  );
}

/** What the probe found at the folder: the ✓ line, or the finding that keeps Add off. */
function FolderLine({
  folder,
  machine,
  check,
  filled,
  slug,
}: {
  folder: string;
  machine: string;
  check: CloneCheck | undefined;
  filled: boolean;
  slug: string;
}) {
  const bad = pathProblem(folder);
  if (bad !== null) return <p className="s-error">{bad}</p>;
  const r = check?.result;
  if (!r) return null;
  if (!r.ok) return <p className="s-hint">{`Could not check ${machine}: ${r.error}`}</p>;
  if (r.state === "no_origin")
    return <p className="s-error">{`${folder} on ${machine} has no origin remote`}</p>;
  const problem = probeProblem(machine, folder, slug.trim() || (r.slug ?? ""), r);
  if (problem !== null) return <p className="s-error">{problem}</p>;
  const origin = r.slug
    ? ` · origin is ${r.slug}${filled && sameSlug(slug, r.slug) ? " (filled in for you)" : ""}`
    : "";
  return <p className="gs-ok">{`✓ Folder exists · git clone${origin}`}</p>;
}
