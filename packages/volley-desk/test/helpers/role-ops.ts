/**
 * A scriptable `RoleOps` (Settings › Machines' role moves, SPEC §4.6.24) for the machine and
 * role-move tests: `plan` answers a clear plan for the role and machine asked, `move` a finished
 * move, `rollback` a new move; pass overrides. `rolePlan` builds a plan to answer with.
 */
import { vi } from "vitest";
import type {
  MachineRole,
  RoleMoveAnswer,
  RoleMoveRequest,
  RoleOps,
  RolePlan,
  RolePlanAnswer,
  RolePlanRequest,
  RoleRollbackAnswer,
} from "../../src/store/roleOps";

export function rolePlan(over: Partial<RolePlan> = {}): RolePlan {
  const role: MachineRole = over.role ?? "broker";
  const to = over.to ?? "box-a";
  return {
    role,
    from: "studio",
    to,
    planId: `role-${role}-5f2c9a1e`,
    steps: [
      { id: "install", title: `Install the ${role} on ${to}`, where: to },
      { id: "retarget", title: "Re-point every tunnel", where: "every machine" },
      { id: "record", title: "Record the move", where: "studio" },
    ],
    blocked: [],
    warnings: [],
    terminal: [],
    after: [`The ${role} runs on ${to}.`],
    ...over,
  };
}

export function fakeRoleOps(over: Partial<RoleOps> = {}) {
  let n = 0;
  return {
    plan: vi.fn(
      async (req: RolePlanRequest): Promise<RolePlanAnswer> => ({
        ok: true,
        plan: rolePlan({ role: req.role, to: req.to }),
      }),
    ),
    move: vi.fn(
      async (
        req: RoleMoveRequest,
        _opts?: { onLate?: (a: RoleMoveAnswer) => void },
      ): Promise<RoleMoveAnswer> => ({
        ok: true,
        moveId: `mv-${req.role}-${++n}`,
        status: req.role === "supervisor" ? "running" : "done",
        ...(req.role === "supervisor" ? { handingOver: true } : {}),
      }),
    ),
    rollback: vi.fn(
      async (moveId: string): Promise<RoleRollbackAnswer> => ({
        ok: true,
        moveId: `mv-undo-${++n}`,
        rollsBack: moveId,
      }),
    ),
    ...over,
  };
}
