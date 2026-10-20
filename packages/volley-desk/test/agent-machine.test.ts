import { describe, expect, it } from "vitest";
import { initialState } from "../src/store/reducer";
import type { AgentView, DeskState, WaveTask } from "../src/store/types";
import { machineDot, machineTip } from "../src/windows/agent/MachineChip";
import { LOCAL_LABEL, machineFor } from "../src/windows/agent/machine";
import { machineRecord, placement, readiness, waveState, waveView } from "./helpers/desk-msgs";

const LOCAL = "hub";

function setup(task: Partial<WaveTask> | null) {
  const tasks: WaveTask[] =
    task === null
      ? []
      : [{ id: "T1", issue: 1, stage: "implement", agents: { implementer: "impl-1" }, ...task }];
  const wave = waveView(waveState({ tasks }));
  const record = machineRecord();
  const verdict = readiness();
  const state: DeskState = {
    ...initialState(),
    waves: { w1: wave },
    config: {
      version: 1,
      updated_at: "2026-10-18T12:00:00.000Z",
      updated_by: "volleyd",
      fleet: { local_name: LOCAL },
    },
    machines: { "box-a": record },
    readiness: { "box-a": verdict },
  };
  const agent = { id: "impl-1", wave: "w1", task: "T1" } as AgentView;
  return { wave, state, agent, record, verdict };
}

describe("machineFor", () => {
  it("a task on a remote host gives that machine's record, verdict and placement", () => {
    const p = placement();
    const { agent, wave, state, record, verdict } = setup({ host: "box-a", placement: p });
    expect(machineFor(agent, wave, state)).toMatchObject({
      name: "box-a",
      local: false,
      record,
      readiness: verdict,
      placement: p,
    });
  });

  it("a task placed on the supervisor's own machine is local", () => {
    const p = placement({ host: LOCAL });
    const { agent, wave, state } = setup({ placement: p });
    expect(machineFor(agent, wave, state)).toMatchObject({ name: LOCAL, local: true });
  });

  it("a task with neither host nor placement gives null", () => {
    const { agent, wave, state } = setup({});
    expect(machineFor(agent, wave, state)).toBeNull();
  });

  it("an agent with no wave task gives null", () => {
    const { wave, state } = setup(null);
    expect(machineFor({ id: "x", wave: "w1", task: null } as AgentView, wave, state)).toBeNull();
    expect(machineFor({ id: "x", wave: "w1", task: "T9" } as AgentView, wave, state)).toBeNull();
  });

  it("labels the local machine", () => {
    expect(LOCAL_LABEL).toBe("this machine");
  });
});

describe("machineDot", () => {
  it("is down when the tunnel is down", () => {
    expect(machineDot(machineRecord({ tunnel: "down" }), undefined, true)).toBe("down");
  });

  it("is overloaded when volleyd finds it ineligible or draining", () => {
    expect(machineDot(machineRecord(), readiness({ eligible: false }), true)).toBe("overloaded");
    expect(machineDot(machineRecord(), readiness({ drain: true }), true)).toBe("overloaded");
  });

  it("is up with a record, unknown without one", () => {
    expect(machineDot(machineRecord(), undefined, true)).toBe("up");
    expect(machineDot(machineRecord(), readiness(), true)).toBe("up");
    expect(machineDot(undefined, undefined, true)).toBe("unknown");
  });

  it("the local machine is down while volleyd is not live", () => {
    const own = machineRecord({ name: LOCAL, kind: "supervisor", tunnel: "local" });
    expect(machineDot(own, undefined, false)).toBe("down");
    expect(machineDot(own, undefined, true)).toBe("up");
  });
});

describe("machineTip", () => {
  it("gives the rule, the host's own candidate line and the load", () => {
    expect(machineTip("box-a", placement(), machineRecord(), readiness())).toEqual([
      "placed automatically at admission",
      "box-a: 0.82 (cpu 0.9, slots 0.5, mem 0.71, usage 0.58)",
      "16 cores · load 1.25 · 2/4 agents",
    ]);
  });

  it("omits the load line without a record and the placement lines without a placement", () => {
    expect(machineTip("box-a", placement(), undefined, undefined)).toEqual([
      "placed automatically at admission",
      "box-a: 0.82 (cpu 0.9, slots 0.5, mem 0.71, usage 0.58)",
    ]);
    expect(machineTip("box-a", undefined, machineRecord(), undefined)).toEqual([
      "16 cores · load 1.25 · 2 agents",
    ]);
  });
});
