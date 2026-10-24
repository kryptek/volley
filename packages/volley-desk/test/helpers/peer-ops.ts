/**
 * A scriptable `PeerOps` (Settings › Machines' and Repositories' admin ops)
 * for the machine and repository tests: every op is a `vi.fn` that succeeds by default; pass overrides.
 */
import { vi } from "vitest";
import type {
  AdminStatus,
  DoctorAnswer,
  MachineAddAnswer,
  MachineAddRequest,
  PeerOps,
  PeerRemoveResult,
  RepoAddResult,
  RepoListResult,
  RepoProbeResult,
  RepoRemoveResult,
  RepoStatusResult,
} from "../../src/store/peerOps";
import type { MachineAddRow, RepoMachines } from "../../src/store/types";
import { NOW } from "./desk-msgs";
import { APP } from "./repos";

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
    repoProbe: vi.fn(
      async (_machine: string, path: string): Promise<RepoProbeResult> => ({
        ok: true,
        state: "found",
        root: path,
        origin: `https://github.com/${APP}`,
        slug: APP,
      }),
    ),
    machineAdd: vi.fn(
      async (
        req: MachineAddRequest,
        _onRow: (r: MachineAddRow) => void,
      ): Promise<MachineAddAnswer> => ({
        ok: true,
        name: req.name ?? "box-a",
        target: req.address,
        ready: true,
        signin: { gh: true, claude: true },
        checks: [],
      }),
    ),
    ...over,
  };
}
