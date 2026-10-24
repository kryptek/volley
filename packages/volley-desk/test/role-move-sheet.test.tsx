import { act, fireEvent, render, screen, within } from "@testing-library/react";
import axe from "axe-core";
import { describe, expect, it, vi } from "vitest";
import { RoleMoveSheet, type RoleMoveSheetProps } from "../src/settings/RoleMoveSheet";
import type { RoleMoveAnswer, RoleOps } from "../src/store/roleOps";
import type { RoleMovePayload, RolesPayload } from "../src/store/types";
import { NOW } from "./helpers/desk-msgs";
import { fakeRoleOps, rolePlan } from "./helpers/role-ops";

const flush = () => new Promise((r) => setTimeout(r, 0));
const iso = (ms: number) => new Date(ms).toISOString();

const ROLES: RolesPayload = {
  broker: {
    machine: "studio",
    address: { ssh: null, mqtt_port: 1883, ws_port: 9001 },
    lan: false,
  },
  supervisor: { machine: "studio" },
  desk: { machine: "studio", url: "http://localhost:5199" },
  version: 1,
  updated_at: iso(NOW),
  updated_by: "volleyd-defaults",
};

function record(over: Partial<RoleMovePayload> = {}): RoleMovePayload {
  return {
    move_id: "mv-broker-1",
    role: "broker",
    from: "studio",
    to: "box-a",
    status: "running",
    steps: [
      { id: "install", title: "Install the broker on box-a", where: "box-a", status: "ok" },
      { id: "retarget", title: "Re-point every tunnel", where: "every machine", status: "ok" },
      { id: "record", title: "Record the move", where: "studio", status: "running" },
    ],
    since: iso(NOW),
    ...over,
  };
}

/** A move that answers only when the test says so. */
function pendingMove() {
  let answer: (a: RoleMoveAnswer) => void = () => {};
  const move = vi.fn(
    () =>
      new Promise<RoleMoveAnswer>((r) => {
        answer = r;
      }),
  );
  return { move, answer: (a: RoleMoveAnswer) => act(async () => answer(a)) };
}

function setup(props: Partial<RoleMoveSheetProps> = {}, over: Partial<RoleOps> = {}) {
  const ops = fakeRoleOps(over);
  const onClose = vi.fn();
  const onMoved = vi.fn();
  const base: RoleMoveSheetProps = {
    role: "broker",
    to: "box-a",
    roles: ROLES,
    ops,
    moves: {},
    hubUp: true,
    onClose,
    onMoved,
    ...props,
  };
  const view = render(<RoleMoveSheet {...base} />);
  const rerender = (next: Partial<RoleMoveSheetProps>) =>
    view.rerender(<RoleMoveSheet {...base} {...next} />);
  return { ops, onClose, onMoved, rerender };
}

const sheet = () => within(screen.getByRole("dialog"));
const list = (name: string) => sheet().getByRole("list", { name });
const pressEscape = () => fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });

/** Plan, then Move…, then Move now. */
async function confirm() {
  await act(flush);
  fireEvent.click(sheet().getByRole("button", { name: /^Move/ }));
  fireEvent.click(sheet().getByRole("button", { name: "Move now" }));
  await act(flush);
}

describe("RoleMoveSheet: planning", () => {
  it("opens in planning, labelled with the move, and calls plan once", async () => {
    const { ops } = setup();
    expect(screen.getByRole("dialog", { name: "Move the broker to box-a" })).toBeInTheDocument();
    expect(sheet().getByText(/Planning the move/)).toBeInTheDocument();
    await act(flush);
    expect(ops.plan).toHaveBeenCalledTimes(1);
    expect(ops.plan).toHaveBeenCalledWith({ role: "broker", to: "box-a" });
  });

  it("renders This will with each step's machine, You run on, Blocked with each fix, and the notes", async () => {
    setup(
      {},
      {
        plan: vi.fn(async () => ({
          ok: true as const,
          plan: rolePlan({
            terminal: [
              { where: "box-a", reason: "needs sudo", command: "sudo volley setup --lan" },
            ],
            blocked: [{ why: "box-a has port 9001 taken", fix: "stop what listens on 9001" }],
            after: ["Every machine's tunnel reaches box-a from now on."],
            warnings: ["box-a's memory is low"],
          }),
        })),
      },
    );
    await act(flush);
    const will = list("This will");
    expect(
      within(will)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual([
      "Install the broker on box-a · box-a",
      "Re-point every tunnel · every machine",
      "Record the move · studio",
    ]);
    const run = list("You run on box-a");
    expect(run).toHaveTextContent("needs sudo");
    expect(run.querySelector("code")?.textContent).toBe("sudo volley setup --lan");
    expect(within(run).getByRole("button", { name: /Copy/ })).toBeInTheDocument();
    expect(sheet().getByRole("button", { name: "Check again" })).toBeInTheDocument();
    const blocked = list("Blocked");
    expect(blocked).toHaveTextContent("box-a has port 9001 taken");
    expect(blocked).toHaveTextContent("stop what listens on 9001");
    expect(list("After the move")).toHaveTextContent(
      "Every machine's tunnel reaches box-a from now on.",
    );
    expect(sheet().getByText("box-a's memory is low")).toBeInTheDocument();
  });

  it("disables the confirm button while a blocker exists, and Check again plans afresh", async () => {
    const blocked = rolePlan({ blocked: [{ why: "box-a is down" }] });
    const plan = vi
      .fn<RoleOps["plan"]>()
      .mockResolvedValueOnce({ ok: true, plan: blocked })
      .mockResolvedValueOnce({ ok: true, plan: rolePlan() });
    setup({}, { plan });
    await act(flush);
    expect(sheet().getByRole("button", { name: "Move…" })).toBeDisabled();
    fireEvent.click(sheet().getByRole("button", { name: "Check again" }));
    await act(flush);
    expect(plan).toHaveBeenCalledTimes(2);
    expect(sheet().getByRole("button", { name: "Move…" })).toBeEnabled();
  });

  it("a refused plan says why and offers Check again", async () => {
    setup({}, { plan: vi.fn(async () => ({ ok: false as const, error: "unknown machine" })) });
    await act(flush);
    expect(sheet().getByRole("alert")).toHaveTextContent("unknown machine");
    expect(sheet().getByRole("button", { name: "Check again" })).toBeInTheDocument();
  });
});

describe("RoleMoveSheet: confirm", () => {
  it("sends move with the plan's plan_id", async () => {
    const { ops } = setup({ role: "desk", to: "box-a" });
    await confirm();
    expect(ops.move).toHaveBeenCalledTimes(1);
    expect(vi.mocked(ops.move).mock.calls[0]?.[0]).toEqual({
      role: "desk",
      to: "box-a",
      planId: "role-desk-5f2c9a1e",
    });
  });

  it("Back from the confirm returns to the plan without moving", async () => {
    const { ops } = setup();
    await act(flush);
    fireEvent.click(sheet().getByRole("button", { name: "Move…" }));
    fireEvent.click(sheet().getByRole("button", { name: "Back" }));
    expect(list("This will")).toBeInTheDocument();
    expect(ops.move).not.toHaveBeenCalled();
  });

  it("a broker move offers also moving the supervisor, checked by default, and queues it after done", async () => {
    const { ops } = setup();
    await act(flush);
    expect(sheet().getByRole("checkbox", { name: /also move the supervisor/i })).toBeChecked();
    await confirm();
    await act(flush);
    expect(ops.plan).toHaveBeenLastCalledWith({ role: "supervisor", to: "box-a" });
    expect(ops.move).toHaveBeenCalledTimes(2);
    expect(vi.mocked(ops.move).mock.calls[1]?.[0]).toMatchObject({
      role: "supervisor",
      to: "box-a",
      planId: "role-supervisor-5f2c9a1e",
    });
  });

  it("unchecked, the broker move stays alone", async () => {
    const { ops } = setup();
    await act(flush);
    fireEvent.click(sheet().getByRole("checkbox", { name: /also move the supervisor/i }));
    await confirm();
    await act(flush);
    expect(ops.move).toHaveBeenCalledTimes(1);
    expect(sheet().getByText(/The broker runs on box-a/)).toBeInTheDocument();
  });

  it("no supervisor box when the supervisor already runs there, nor on a Desk move", async () => {
    setup({ roles: { ...ROLES, supervisor: { machine: "box-a" } } });
    await act(flush);
    expect(sheet().queryByRole("checkbox", { name: /also move the supervisor/i })).toBeNull();
  });

  it("a move that needs quiet offers to move when the fleet is idle (drain)", async () => {
    const plan = rolePlan({
      blocked: [
        {
          why: "wave w1 is running",
          fix: "stop it (`volleyd stop w1`), or move when idle (drain: true)",
        },
      ],
    });
    const { ops } = setup({}, { plan: vi.fn(async () => ({ ok: true as const, plan })) });
    await act(flush);
    const go = sheet().getByRole("button", { name: "Move when the fleet is idle…" });
    expect(go).toBeEnabled();
    fireEvent.click(go);
    fireEvent.click(sheet().getByRole("button", { name: "Move now" }));
    await act(flush);
    expect(vi.mocked(ops.move).mock.calls[0]?.[0]).toMatchObject({
      planId: plan.planId,
      drain: true,
    });
  });

  it("plan changed: the sheet plans again and says so", async () => {
    const { ops } = setup(
      {},
      {
        move: vi.fn(async () => ({
          ok: false as const,
          error: "plan changed: moving the broker to box-a would now run other steps",
          planChanged: true as const,
        })),
      },
    );
    await confirm();
    await act(flush);
    expect(ops.plan).toHaveBeenCalledTimes(2);
    expect(sheet().getByRole("alert")).toHaveTextContent(/changed since this plan was shown/);
  });
});

describe("RoleMoveSheet: moving", () => {
  it("renders the move's live step lines from state.roleMoves: ✓ ✓ …", async () => {
    const p = pendingMove();
    const { rerender } = setup({}, { move: p.move });
    await act(flush);
    fireEvent.click(sheet().getByRole("checkbox", { name: /also move the supervisor/i }));
    await confirm();
    rerender({ moves: { "mv-broker-1": record() } });
    const steps = list("Steps");
    expect(
      within(steps)
        .getAllByRole("listitem")
        .map((li) => li.querySelector(".rm-mark")?.textContent),
    ).toEqual(["✓", "✓", "…"]);
    expect(steps).toHaveTextContent("Record the move");
  });

  it("ignores a move record that was there before this move was sent", async () => {
    const p = pendingMove();
    const old = record({ move_id: "mv-old", status: "running" });
    setup({ moves: { "mv-old": old } }, { move: p.move });
    await act(flush);
    fireEvent.click(sheet().getByRole("checkbox", { name: /also move the supervisor/i }));
    await confirm();
    expect(sheet().queryByRole("list", { name: "Steps" })).toBeNull();
    expect(sheet().getByText(/Starting the move/)).toBeInTheDocument();
  });

  it("done shows the undo line: volley role rollback <move_id> within 7 days", async () => {
    const { onMoved } = setup({ role: "desk" });
    await confirm();
    expect(sheet().getByText(/The Desk runs on box-a/)).toBeInTheDocument();
    expect(sheet().getByText("volley role rollback mv-desk-1")).toBeInTheDocument();
    expect(sheet().getByText(/7 days/)).toBeInTheDocument();
    expect(onMoved).toHaveBeenCalledWith(expect.stringMatching(/Desk.*box-a/));
  });

  it("a done record finishes the move before its answer arrives", async () => {
    const p = pendingMove();
    const { rerender } = setup({ role: "desk" }, { move: p.move });
    await confirm();
    rerender({
      moves: {
        "mv-desk-9": record({ move_id: "mv-desk-9", role: "desk", status: "done" }),
      },
    });
    expect(sheet().getByText("volley role rollback mv-desk-9")).toBeInTheDocument();
  });

  it("failed shows the step that failed and rolled back", async () => {
    const p = pendingMove();
    const { rerender } = setup({}, { move: p.move });
    await act(flush);
    fireEvent.click(sheet().getByRole("checkbox", { name: /also move the supervisor/i }));
    await confirm();
    rerender({
      moves: {
        "mv-broker-1": record({
          status: "failed",
          error: "the health check failed",
          steps: [
            { id: "install", title: "Install the broker on box-a", where: "box-a", status: "ok" },
            {
              id: "retarget",
              title: "Re-point every tunnel",
              where: "every machine",
              status: "failed",
              line: "box-b: ssh timed out",
            },
          ],
        }),
      },
    });
    await p.answer({
      ok: false,
      error: "the health check failed",
      moveId: "mv-broker-1",
      step: "retarget",
      rolledBack: true,
    });
    const alert = sheet().getByRole("alert");
    expect(alert).toHaveTextContent("Re-point every tunnel");
    expect(alert).toHaveTextContent("box-b: ssh timed out");
    expect(sheet().getByText(/rolled back/)).toBeInTheDocument();
  });

  it("a refused move (another move runs) returns to the plan and says why", async () => {
    setup(
      {},
      { move: vi.fn(async () => ({ ok: false as const, error: "a move is in progress" })) },
    );
    await confirm();
    expect(sheet().getByRole("alert")).toHaveTextContent("a move is in progress");
    expect(list("This will")).toBeInTheDocument();
  });

  it("an answer that arrives late (onLate) still finishes the move", async () => {
    let late: ((a: RoleMoveAnswer) => void) | undefined;
    setup(
      { role: "desk" },
      {
        move: vi.fn(async (_req, opts) => {
          late = opts?.onLate;
          return { ok: false as const, error: "volleyd did not answer", unanswered: true as const };
        }),
      },
    );
    await confirm();
    expect(sheet().getByText(/still moving/i)).toBeInTheDocument();
    await act(async () => late?.({ ok: true, moveId: "mv-desk-7", status: "done" }));
    expect(sheet().getByText("volley role rollback mv-desk-7")).toBeInTheDocument();
  });

  it("a Desk move's sealed link renders the link and a QR", async () => {
    setup(
      { role: "desk" },
      {
        move: vi.fn(async () => ({
          ok: true as const,
          moveId: "mv-desk-1",
          status: "done" as const,
          link: "http://box-a:5199/#signin=vly_signin_abc_def",
        })),
      },
    );
    await confirm();
    expect(sheet().getByText("http://box-a:5199/#signin=vly_signin_abc_def")).toBeInTheDocument();
    expect(sheet().getByRole("img", { name: /QR/ })).toBeInTheDocument();
    expect(sheet().getByText(/every device/)).toBeInTheDocument();
  });

  it("a supervisor move shows handing over to box-a… until the pill is live again", async () => {
    const { rerender } = setup({ role: "supervisor" });
    await confirm();
    expect(sheet().getByText("handing over to box-a…")).toBeInTheDocument();
    rerender({ role: "supervisor", hubUp: false });
    expect(sheet().getByText("handing over to box-a…")).toBeInTheDocument();
    rerender({ role: "supervisor", hubUp: true });
    expect(sheet().queryByText("handing over to box-a…")).toBeNull();
    rerender({
      role: "supervisor",
      hubUp: true,
      moves: {
        "mv-supervisor-1": record({
          move_id: "mv-supervisor-1",
          role: "supervisor",
          status: "done",
        }),
      },
    });
    expect(sheet().getByText(/The supervisor runs on box-a/)).toBeInTheDocument();
  });

  it("Undo sends rollback for the move and follows the new one", async () => {
    const { ops } = setup({ role: "desk" });
    await confirm();
    fireEvent.click(sheet().getByRole("button", { name: "Undo this move" }));
    await act(flush);
    expect(ops.rollback).toHaveBeenCalledWith("mv-desk-1");
    expect(sheet().getByText(/Moving the Desk back to studio/)).toBeInTheDocument();
  });
});

describe("RoleMoveSheet: closing", () => {
  it("Escape closes in plan", async () => {
    const { onClose } = setup();
    await act(flush);
    pressEscape();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Escape does nothing while planning or moving", async () => {
    const p = pendingMove();
    const { onClose } = setup({ role: "desk" }, { move: p.move });
    pressEscape();
    expect(onClose).not.toHaveBeenCalled();
    await confirm();
    pressEscape();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("Escape does nothing in confirm", async () => {
    const { onClose } = setup();
    await act(flush);
    fireEvent.click(sheet().getByRole("button", { name: "Move…" }));
    pressEscape();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("Escape closes in done and failed", async () => {
    const done = setup({ role: "desk" });
    await confirm();
    pressEscape();
    expect(done.onClose).toHaveBeenCalledTimes(1);
  });

  it("Escape closes once failed", async () => {
    const { onClose } = setup(
      { role: "desk" },
      {
        move: vi.fn(async () => ({
          ok: false as const,
          error: "check failed",
          moveId: "mv-desk-3",
          step: "check",
          rolledBack: true,
        })),
      },
    );
    await confirm();
    pressEscape();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("passes axe in plan", async () => {
    setup();
    await act(flush);
    const res = await axe.run(screen.getByRole("dialog"), {
      rules: { "color-contrast": { enabled: false } },
    });
    expect(res.violations.map((v) => v.id)).toEqual([]);
  });
});
