import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { demoMessages } from "../src/store/fixtures";
import { initialState, reduceAll } from "../src/store/reducer";
import type { DeskMessage, DeskState } from "../src/store/types";
import { AgentWindow, agentPurpose } from "../src/windows/agent/AgentWindow";

const NOW = Date.parse("2026-10-18T12:00:00Z");
const FIXUP = "status-chip-t1-fixup-1";

const frame = {
  pos: { x: 0, y: 0 },
  z: 1,
  scale: 1,
  chrome: "glass" as const,
  onMove: () => {},
  onFocus: () => {},
};

/** A retained registry entry for `id`, with `extra` folded into its payload. */
function registry(id: string, extra: Record<string, unknown> = {}): DeskMessage {
  const at = NOW - 60_000;
  return {
    topic: `volley/_system/registry/${id}`,
    envelope: {
      schema_version: "0.1",
      agent_id: id,
      channel: "_system/registry",
      type: "registered",
      payload: { capabilities: [], started_at: new Date(at).toISOString(), ...extra },
    },
    receivedAt: at,
  };
}

function stateWith(...extra: DeskMessage[]): DeskState {
  return reduceAll(initialState(), [...demoMessages(NOW), ...extra]);
}

function renderAgent(state: DeskState, id: string) {
  const agent = state.agents[id];
  if (!agent) throw new Error(`no agent ${id}`);
  return render(
    <AgentWindow
      agent={agent}
      wave={state.waves[agent.wave]}
      accent="#c4b5fd"
      frame={frame}
      now={NOW}
    />,
  );
}

describe("agent purpose line", () => {
  it("a wave task's title is the purpose, ahead of a registered one", () => {
    const state = stateWith(registry(FIXUP, { title: "Something the agent said" }));
    const agent = state.agents[FIXUP];
    if (!agent) throw new Error("no fixup agent");
    expect(agentPurpose(agent, state.waves[agent.wave])).toBe("Chip mapper + null-case handling");
  });

  it("a task-less agent's purpose is its registered title, trimmed; blank or missing is none", () => {
    const state = stateWith(
      registry("coordinator-ab12", { title: "  #169: Desk agent purpose line  " }),
      registry("coordinator-cd34", { title: "   " }),
      registry("coordinator-ef56"),
      registry("coordinator-gh78", { title: 42 }),
    );
    const purpose = (id: string) => {
      const a = state.agents[id];
      if (!a) throw new Error(`no agent ${id}`);
      return agentPurpose(a, state.waves[a.wave]);
    };
    expect(purpose("coordinator-ab12")).toBe("#169: Desk agent purpose line");
    expect(purpose("coordinator-cd34")).toBeNull();
    expect(purpose("coordinator-ef56")).toBeNull();
    expect(purpose("coordinator-gh78")).toBeNull();
  });

  it("a wave agent shows the task title as its purpose line and its agent id as a secondary line", () => {
    const { container } = renderAgent(stateWith(), FIXUP);
    const bar = container.querySelector(".win-bar") as HTMLElement;
    expect(bar.querySelector(".t-name")).toHaveTextContent("T1 #102");
    expect(container.querySelector(".a-title")).toHaveTextContent(
      "Chip mapper + null-case handling",
    );
    const id = container.querySelector(".a-id") as HTMLElement;
    expect(id).toHaveTextContent(FIXUP);
    // Secondary: after the purpose line, never in the title bar.
    expect(within(bar).queryByText(FIXUP)).toBeNull();
    expect(
      (container.querySelector(".a-title") as HTMLElement).compareDocumentPosition(id) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("a task-less agent with a registered title shows it whole as the purpose line; its id is dimmed", () => {
    const id = "coordinator-ab12";
    const title = "#169: Desk agent windows say what each agent is doing";
    const { container } = renderAgent(stateWith(registry(id, { title })), id);
    // In full on the body line (a title bar would cut it, and a phone has no hover).
    expect(container.querySelector(".a-title")).toHaveTextContent(title);
    const name = container.querySelector(".win-bar .t-name") as HTMLElement;
    expect(name).toHaveTextContent(id);
    expect(name).toHaveClass("t-name--id", "dim");
    // Once each: the id is not repeated as a body line, the title not in the bar.
    expect(container.querySelector(".a-id")).toBeNull();
    expect(screen.getAllByText(title)).toHaveLength(1);
    expect(screen.getAllByText(id)).toHaveLength(1);
    // The window's accessible name is the purpose.
    expect(screen.getByRole("region", { name: title })).toBeInTheDocument();
  });

  it("a task-less agent with no title keeps its id as the name, once", () => {
    const id = "coordinator-ef56";
    const { container } = renderAgent(stateWith(registry(id)), id);
    expect(container.querySelector(".win-bar .t-name")).toHaveTextContent(id);
    expect(container.querySelector(".win-bar .t-name")).not.toHaveClass("t-name--id");
    expect(container.querySelector(".a-title")).toBeNull();
    expect(container.querySelector(".a-id")).toBeNull();
    expect(screen.getAllByText(id)).toHaveLength(1);
  });

  it("a re-registration with a new title replaces the old one", () => {
    const id = "coordinator-ab12";
    const state = stateWith(registry(id, { title: "Reading the plan" }), {
      ...registry(id, { title: "Writing the tests" }),
      receivedAt: NOW - 1000,
    });
    renderAgent(state, id);
    expect(screen.getByText("Writing the tests")).toBeInTheDocument();
    expect(screen.queryByText("Reading the plan")).toBeNull();
  });
});
