/**
 * Settings › Repositories (SPEC §4.6.21): which repositories the machines work on, on which
 * machines, and whether each is ready there. One row per repository config names
 * (`repos.<owner/name>`, and any only adopted on a host): its slug (a link to GitHub), a chip per
 * machine it is assigned to (`all`: the supervisor's own and every paired one) with volleyd's
 * verdict there (`ready`, `cloning…`, `blocked: <why>`, `no clone yet`), the toolchain the
 * machines' records say it lacks, and **Remove…**, which confirms with the clone paths it leaves
 * on disk (a clone is never deleted) and sends `repo_remove`. A blocked paired machine's chip has
 * **Repair** (the machine's doctor, `RepairSheet`, with a row per repository there): a successful
 * run also makes volleyd retry the repository's run there. **Add repository…** opens
 * `AddRepoSheet`. Every action names its terminal twin in the footer (`volley repo …`).
 *
 * Adding and removing are admin ops on the Desk's admin channel, like pairing (`peerOps.ts`); any
 * other session sees the rows read-only.
 */
import { useState } from "react";
import { SwitchToAdmin } from "../auth/AccountActions";
import { repoHref } from "../lib/github";
import { type AdminStatus, type PeerOps, pairingSupported } from "../store/peerOps";
import type { ConfigPayload, MachinePayload, ReadinessPayload } from "../store/types";
import { AddRepoSheet } from "./AddRepoSheet";
import { MachineSheet } from "./MachineSheet";
import { useAdmin } from "./Machines";
import { RepairSheet } from "./RepairSheet";
import { Group } from "./primitives";
import {
  allMachines,
  assignedMachines,
  configuredRepos,
  repoOn,
  reposOnMachine,
  stateText,
  toolchainSummary,
} from "./repos";
import "../styles/machines.css";

export interface RepositoriesProps {
  /** The retained `_waves/_config`: `repos`, `hosts` (and their adopted clones), `fleet.local_name`. */
  config: ConfigPayload | null;
  /** Machine records, by name: each one's clones and the toolchain they lack. */
  machines: Record<string, MachinePayload>;
  /** volleyd's readiness verdicts, by machine name: where each repository stands there. */
  readiness: Record<string, ReadinessPayload>;
  /** `null` = no op channel (not signed in, demo): read-only. */
  ops: PeerOps | null;
  /** Whether volleyd is live (the admin check asks again when it comes up). */
  hubUp: boolean;
}

/** Why this session cannot add or remove repositories. */
function readOnlyReason(secure: boolean, admin: AdminStatus | null): string {
  if (!secure) return "Read-only here: this browser cannot make the key the admin channel needs.";
  if (admin === null) return "Checking whether this Desk may change repositories…";
  if (admin === "no-answer") {
    return "volleyd did not answer, so this Desk cannot tell whether it may change repositories.";
  }
  return "Read-only: adding and removing repositories takes an admin account.";
}

/** Remove…'s confirmation: the clones it leaves on disk, then `repo_remove`. */
function RemoveRepoSheet({
  slug,
  clones,
  ops,
  onClose,
  onDone,
}: {
  slug: string;
  clones: { machine: string; path: string }[];
  ops: PeerOps;
  onClose: () => void;
  onDone: (notice: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const remove = async () => {
    setBusy(true);
    setError(null);
    const r = await ops.repoRemove(slug);
    setBusy(false);
    if (!r.ok) {
      setError(r.error);
      return;
    }
    const left = Object.entries(r.clones).map(([m, path]) => `${m}: ${path}`);
    onDone(
      `Removed ${r.slug}. ${left.length > 0 ? `Clones left on disk: ${left.join("; ")}.` : "No clone was left on disk."}`,
    );
  };
  return (
    <MachineSheet label={`Remove ${slug}`} onClose={onClose}>
      <p>
        Remove <b>{slug}</b> from every machine? Agents for its waves are no longer placed there.
      </p>
      <p className="s-hint">Clones are never deleted: these stay on disk.</p>
      {clones.length > 0 && (
        <ul className="m-plan" aria-label="Clones left on disk">
          {clones.map((c) => (
            <li key={c.machine}>
              <b>{c.machine}</b> <span className="mono">{c.path}</span>
            </li>
          ))}
        </ul>
      )}
      {error && (
        <p className="s-error" role="alert">
          {error}
        </p>
      )}
      <div className="ny-actions">
        <button type="button" className="btn" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="btn m-remove"
          disabled={busy}
          onClick={() => void remove()}
        >
          {busy ? "Removing…" : "Remove"}
        </button>
      </div>
    </MachineSheet>
  );
}

export function Repositories(p: RepositoriesProps) {
  const secure = pairingSupported();
  const admin = useAdmin(secure ? p.ops : null, p.hubUp);
  const ops = secure && admin === "admin" ? p.ops : null;
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [repairing, setRepairing] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const local = p.config?.fleet?.local_name ?? null;
  const every = allMachines(p.config);
  const slugs = configuredRepos(p.config);
  const twin = every.find((m) => m !== local) ?? every[0] ?? "box-a";
  const clonesOf = (slug: string) =>
    assignedMachines(p.config, slug).flatMap((m) => {
      const path = repoOn(slug, p.machines[m], p.readiness[m]).path;
      return path ? [{ machine: m, path }] : [];
    });

  return (
    <div className="repos-section">
      <p className="dim">
        The repositories your machines work on, and whether each is ready there. Adding one clones
        it on every machine you pick and trusts it for Claude Code.
      </p>
      {notice && <output className="s-hint m-notice">{notice}</output>}
      <Group
        foot={
          <>
            From a terminal:{" "}
            <code className="mono">{`volley repo add owner/name --machine ${twin}`}</code> adds one
            (without <code className="mono">--machine</code>: every machine),{" "}
            <code className="mono">volley repo remove owner/name</code> removes one and{" "}
            <code className="mono">volley repo status</code> shows where each stands.
          </>
        }
      >
        {slugs.length === 0 && (
          <p className="s-hint repo-empty">
            No repositories yet. Add one and every machine you pick clones it, ready for agents.
          </p>
        )}
        {slugs.map((slug) => {
          const on = assignedMachines(p.config, slug);
          const href = repoHref(slug);
          const tools = toolchainSummary(slug, on, p.machines);
          return (
            <article key={slug} className="repo" aria-label={slug}>
              <div className="repo-head">
                {href ? (
                  <a className="mono repo-slug" href={href} target="_blank" rel="noreferrer">
                    {slug}
                  </a>
                ) : (
                  <b className="mono repo-slug">{slug}</b>
                )}
                {tools && <span className="s-hint repo-tools">{tools}</span>}
                {ops && (
                  <button
                    type="button"
                    className="btn m-remove"
                    aria-label={`Remove ${slug}…`}
                    onClick={() => {
                      setNotice(null);
                      setRemoving(slug);
                    }}
                  >
                    Remove…
                  </button>
                )}
              </div>
              <ul className="repo-chips" aria-label={`Machines for ${slug}`}>
                {on.map((m) => {
                  const r = repoOn(slug, p.machines[m], p.readiness[m]);
                  const text = stateText(r, "waiting for volleyd");
                  // The supervisor's own clone is not repaired over ssh: its reason says what to run.
                  const repair = ops && r.state === "blocked" && m !== local;
                  return (
                    <li
                      key={m}
                      className={`repo-chip repo-chip--${r.state ?? "none"}`}
                      aria-label={`${m}: ${text}`}
                      title={r.reasons.join("\n") || r.path}
                    >
                      <b>{m}</b>
                      <span className="ell">{text}</span>
                      {r.state === "cloning" && <span className="spinner" aria-hidden="true" />}
                      {repair && (
                        <button
                          type="button"
                          className="btn repo-repair"
                          aria-label={`Repair ${m}`}
                          onClick={() => setRepairing(m)}
                        >
                          Repair
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            </article>
          );
        })}
      </Group>
      {ops && (
        <div className="ny-actions">
          <button
            type="button"
            className="btn btn--hot"
            onClick={() => {
              setNotice(null);
              setAdding(true);
            }}
          >
            Add repository…
          </button>
        </div>
      )}
      {!ops && (
        <p className="s-hint m-readonly">
          {readOnlyReason(secure, admin)} {secure && admin === "not-admin" && <SwitchToAdmin />}
        </p>
      )}
      {ops && adding && (
        <AddRepoSheet
          ops={ops}
          machines={every}
          localName={local}
          readiness={p.readiness}
          onClose={() => setAdding(false)}
        />
      )}
      {ops && removing && (
        <RemoveRepoSheet
          slug={removing}
          clones={clonesOf(removing)}
          ops={ops}
          onClose={() => setRemoving(null)}
          onDone={(n) => {
            setRemoving(null);
            setNotice(n);
          }}
        />
      )}
      {ops && repairing && (
        <RepairSheet
          machine={repairing}
          ops={ops}
          repos={reposOnMachine(repairing, p.config, p.machines[repairing], p.readiness[repairing])}
          onClose={() => setRepairing(null)}
        />
      )}
    </div>
  );
}
