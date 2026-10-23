/**
 * A scriptable `PeerOps` (Settings › Machines' and Repositories' admin ops)
 * for the machine and repository tests: every op is a `vi.fn` that succeeds by default; pass overrides.
 */
import { vi } from "vitest";
import type {
  AdminStatus,
  DoctorAnswer,
  PeerOps,
  PeerRemoveResult,
  RepoAddResult,
  RepoListResult,
  RepoRemoveResult,
  RepoStatusResult,
} from "../../src/store/peerOps";
import type { RepoMachines } from "../../src/store/types";
import { NOW } from "./desk-msgs";

type Known = ReturnType<PeerOps["known"]>;

export function fakePeerOps(over: Partial<PeerOps> = {}) {
  return {
    known: vi.fn((): Known => null),
    admin: vi.fn(async (): Promise<AdminStatus> => "admin"),
    invite: vi.fn(async (_for?: string) => ({
      ok: true as const,
      code: "MXQ4-7KDP",
      expiresAt: new Date(NOW + 600_000).toISOString(),
    })),
    remove: vi.fn(
      async (_name: string, _mode?: "drain" | "now"): Promise<PeerRemoveResult> => ({ ok: true }),
    ),
    doctor: vi.fn(
      async (
        _name: string,
        _opts: { fix: boolean; clone?: boolean; reposAdd?: string[] },
      ): Promise<DoctorAnswer> => ({ ok: true, checks: [], plan: [] }),
    ),
    repoAdd: vi.fn(
      async (
        slug: string,
        _opts?: { machines?: RepoMachines; paths?: Record<string, string> },
      ): Promise<RepoAddResult> => ({
        ok: true,
        slug,
        url: `https://github.com/${slug}`,
        machines: [],
        status: [],
      }),
    ),
    repoRemove: vi.fn(
      async (slug: string, _machines?: string[]): Promise<RepoRemoveResult> => ({
        ok: true,
        slug,
        machines: [],
        clones: {},
        peers: {},
      }),
    ),
    repoList: vi.fn(async (): Promise<RepoListResult> => ({ ok: true, repos: [] })),
    repoStatus: vi.fn(
      async (_slug?: string): Promise<RepoStatusResult> => ({ ok: true, repos: [] }),
    ),
    ...over,
  };
}
