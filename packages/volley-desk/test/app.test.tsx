import { readFileSync } from "node:fs";
import path from "node:path";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import App from "../src/App";
import { DeskStoreProvider } from "../src/store/context";
import type { DeskMqttClient } from "../src/store/mqtt-client";
import type { DeskMessage, Envelope } from "../src/store/types";

describe("App (demo mode)", () => {
  it("renders a wave window per demo wave, an agent window per agent, and the top-bar counts", () => {
    const { container } = render(
      <DeskStoreProvider demo>
        <App />
      </DeskStoreProvider>,
    );
    // 3 waves + 5 agents + the coordinators window.
    expect(container.querySelectorAll(".world .win")).toHaveLength(3 + 5 + 1);
    // Agent windows use .t-name too; wave windows are the ones with a dependency graph.
    const waveNames = [...container.querySelectorAll(".world .win")]
      .filter((w) => w.querySelector(".dag"))
      .map((w) => w.querySelector(".t-name")?.textContent);
    expect(waveNames).toEqual(["status-chip", "ci-speed", "leaderboard"]);
    expect(screen.getByRole("region", { name: "status-chip" })).toBeInTheDocument();
    expect(container.querySelectorAll(".world .narr")).toHaveLength(5);
    expect(container.querySelectorAll(".world .dag")).toHaveLength(3);
    expect(screen.getByText("Demo · sample data")).toBeInTheDocument();
    expect(container.querySelector(".topbar-mid")?.textContent).toContain("3 waves");
  });
});

describe("App attention (demo mode)", () => {
  it("pulses the waves that need you, shows their banners, the pill and the coordinators window", () => {
    const { container } = render(
      <DeskStoreProvider demo>
        <App />
      </DeskStoreProvider>,
    );
    const win = (name: string) => screen.getByRole("region", { name });
    expect(win("status-chip")).toHaveClass("win--attn-you");
    expect(win("status-chip").querySelector(".win-attn-pulse")).not.toBeNull();
    expect(win("status-chip")).toHaveTextContent(
      "Needs you: the coordinator is waiting for your answer",
    );
    expect(win("leaderboard")).toHaveClass("win--attn-you");
    expect(win("leaderboard")).toHaveTextContent("Needs you: no coordinator for 34 min");
    expect(win("ci-speed")).toHaveClass("win--attn-coordinator");
    expect(win("Wave coordinators")).toBeInTheDocument();
    expect(container.querySelector(".topbar .ny-pill")?.textContent).toMatch(/\d+ needs? you/);
  });
});

describe("App (live store)", () => {
  const wave = JSON.parse(
    readFileSync(
      path.resolve(__dirname, "../../../spec/examples/valid/wave-state-running.json"),
      "utf8",
    ),
  ) as Envelope;
  const decision = (id: string, wave: string, resolved: boolean): DeskMessage => ({
    topic: `volley/_waves/${wave}/decisions/${id}`,
    envelope: {
      schema_version: "0.1",
      agent_id: "volleyd",
      channel: "_waves/decisions",
      type: resolved ? "decision_resolved" : "decision_opened",
      payload: {
        decision_id: id,
        wave,
        task: null,
        kind: "plan_change",
        question: "?",
        pointers: {},
        opened_at: "2026-10-18T14:00:00.000Z",
        ...(resolved
          ? { resolved: { answer: "yes", by: "owner", at: "2026-10-18T14:01:00.000Z" } }
          : {}),
      },
    },
    receivedAt: 1_000,
  });

  function fakeClient(msgs: DeskMessage[]): () => DeskMqttClient {
    return () => {
      const handlers = new Set<(m: DeskMessage) => void>();
      const none = () => () => {};
      return {
        connect: async () => {
          setTimeout(() => {
            for (const m of msgs) for (const h of handlers) h(m);
          }, 0);
        },
        disconnect: async () => {},
        onMessage: (h) => {
          handlers.add(h);
          return () => handlers.delete(h);
        },
        onConnect: none,
        onDisconnect: none,
        onError: none,
      };
    };
  }

  it("counts only unresolved decisions and labels a decision-only wave as waiting", async () => {
    const factory = fakeClient([
      { topic: "volley/_waves/w1/state", envelope: wave, receivedAt: 1_000 },
      decision("d1", "w1", false),
      decision("d2", "w1", true),
      decision("d3", "w2", false),
    ]);
    const { container } = render(
      <DeskStoreProvider demo={false} brokerUrl="ws://test.invalid" clientFactory={factory}>
        <App />
      </DeskStoreProvider>,
    );
    expect(await screen.findByText(/1 decision ·/)).toBeInTheDocument();
    expect(screen.getByText("waiting for wave state")).toBeInTheDocument();
    expect(container.querySelector(".topbar-mid")?.textContent).toContain("1 waves");
  });
});
