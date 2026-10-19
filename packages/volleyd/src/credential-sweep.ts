import type { CredentialStore } from "./identity";
import type { NewEvent } from "./types";

/**
 * The credential sweep: Dynamic Security has no expiry of any kind (a client is a username, a password hash and roles), and the
 * plugin rewrites its whole state file on every change, so a login nobody deletes costs every
 * later mint. volleyd lists the agent logins at start and every `credential_sweep_interval_s`,
 * and deletes each one with no live agent behind it (through the delete path: `reaped`, record
 * clear, deleteClient). It only ever touches logins holding volley-agent alone: the fixed
 * identities, accounts, token logins and the admin are never candidates.
 */

export interface SweepInput {
  /** The broker's agent logins right now. */
  logins: readonly string[];
  /** Agents that are live: supervised, non-terminal in a running wave, holding a lock, or with a
   * spawning / registered / working status. */
  live: ReadonlySet<string>;
  /** When this daemon minted a login (a spawn in flight is not journaled yet). */
  mintedAt: ReadonlyMap<string, number>;
  /** When a login unknown to `mintedAt` was first listed (updated in place). */
  firstSeen: Map<string, number>;
  now: number;
  /** A login younger than this is spared (`spawn_timeout_s`). */
  graceMs: number;
}

export interface SweepPlan {
  sweep: string[];
  /** Logins kept: live, or too young to judge. */
  kept: string[];
}

/** Which logins to delete. Also prunes and fills `i.firstSeen` in place (its only side effect). */
export function planSweep(i: SweepInput): SweepPlan {
  const listed = new Set(i.logins);
  for (const id of [...i.firstSeen.keys()]) if (!listed.has(id)) i.firstSeen.delete(id);
  const sweep: string[] = [];
  const kept: string[] = [];
  for (const id of i.logins) {
    if (i.live.has(id)) {
      kept.push(id);
      continue;
    }
    let born = i.mintedAt.get(id);
    if (born === undefined) {
      born = i.firstSeen.get(id) ?? i.now;
      i.firstSeen.set(id, born);
    }
    if (i.now - born < i.graceMs) kept.push(id);
    else sweep.push(id);
  }
  return { sweep: sweep.sort(), kept: kept.sort() };
}

/** `store` with a re-count after every mint and revoke, so the cached `status` count follows them. */
export function recounted(store: CredentialStore, recount: () => void): CredentialStore {
  return {
    mint: async (agentId) => {
      try {
        return await store.mint(agentId);
      } finally {
        recount();
      }
    },
    revoke: async (agentId) => {
      const ok = await store.revoke(agentId);
      recount();
      return ok;
    },
    agentLogins: () => store.agentLogins(),
    get mintedAt() {
      return store.mintedAt;
    },
  };
}

export interface SweeperDeps {
  credentials: CredentialStore;
  /** The live agents, judged from candidates (the logins not obviously live). */
  live: (candidates: readonly string[]) => Promise<ReadonlySet<string>>;
  /** The delete path for one login (reapAndRevoke with the agent's namespace). */
  reap: (agentId: string) => Promise<boolean>;
  /** The `_system` journal. */
  journal: (ev: NewEvent) => unknown | Promise<unknown>;
  graceMs: () => number;
  /** Wall-clock ms (the daemon's clock). */
  now: () => number;
}

export interface SweepCounts {
  /** Agent logins on the broker: counted by the last sweep, or by a `refreshSoon()` since. */
  live: number;
  /** Logins swept, in total (from the `_system` journal across restarts). */
  swept: number;
}

export class CredentialSweeper {
  private readonly firstSeen = new Map<string, number>();
  private running: Promise<string[]> | null = null;

  constructor(
    private readonly d: SweeperDeps,
    readonly counts: SweepCounts = { live: 0, swept: 0 },
  ) {}

  private refreshing: Promise<void> | null = null;
  private again = false;

  /**
   * Re-count the agent logins in the background (one paged listClients; overlapping calls share
   * it, and one made during it runs it once more). Never awaited where an answer is due:
   * `volleyd status` reads `counts`, which keeps the last count while the broker is slow.
   */
  refreshSoon(): void {
    if (this.refreshing !== null) {
      this.again = true;
      return;
    }
    this.refreshing = (async () => {
      do {
        this.again = false;
        try {
          this.counts.live = (await this.d.credentials.agentLogins()).length;
        } catch {}
      } while (this.again);
    })().finally(() => {
      this.refreshing = null;
    });
  }

  /** Resolves once a background re-count in flight (if any) is done. */
  async refreshed(): Promise<void> {
    await this.refreshing;
  }

  /** One sweep (concurrent calls share it). Returns the swept agent ids. */
  sweep(): Promise<string[]> {
    this.running ??= this.once().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async once(): Promise<string[]> {
    const logins = await this.d.credentials.agentLogins();
    const live = await this.d.live(logins);
    const plan = planSweep({
      logins,
      live,
      mintedAt: this.d.credentials.mintedAt,
      firstSeen: this.firstSeen,
      now: this.d.now(),
      graceMs: this.d.graceMs(),
    });
    const swept: string[] = [];
    // One reap per login; their deletes share the batch window, so they go as one message.
    const done = await Promise.all(plan.sweep.map((id) => this.d.reap(id)));
    plan.sweep.forEach((id, k) => {
      if (done[k] === true) swept.push(id);
    });
    if (swept.length > 0) {
      await this.d.journal({ type: "credentials_swept", data: { agent_ids: swept } });
    }
    this.counts.live = logins.length - swept.length;
    this.counts.swept += swept.length;
    return swept;
  }
}
