/**
 * A scriptable `PeerOps` (Settings › Machines' admin ops) for the machine
 * tests: every op is a `vi.fn` that succeeds by default; pass overrides.
 */
import { vi } from "vitest";
import type { AdminStatus, DoctorAnswer, PeerOps, PeerRemoveResult } from "../../src/store/peerOps";
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
      async (_name: string, _opts: { fix: boolean; clone?: boolean }): Promise<DoctorAnswer> => ({
        ok: true,
        checks: [],
        plan: [],
      }),
    ),
    ...over,
  };
}
