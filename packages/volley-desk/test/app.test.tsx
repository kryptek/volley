import { readFileSync } from "node:fs";
import path from "node:path";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import App from "../src/App";
import { DeskStoreProvider } from "../src/store/context";
import type { DeskMqttClient } from "../src/store/mqtt-client";
import type { DeskMessage, Envelope } from "../src/store/types";

describe("App (demo mode)", () => {
  it("renders a wave window per demo wave, a placeholder per agent, and the top-bar counts", () => {
    const { container } = render(
      <DeskStoreProvider demo>
        <App />
      </DeskStoreProvider>,
    );
    expect(container.querySelectorAll(".world .win")).toHaveLength(3 + 5);
    const waveNames = [...container.querySelectorAll(".world .win .t-name")].map(
      (n) => n.textContent,
    );
    expect(waveNames).toEqual(["status-chip", "ci-speed", "leaderboard"]);
    expect(container.querySelectorAll(".world .dag")).toHaveLength(3);
    expect(screen.getByRole("region", { name: "status-chip-t1-fixup-1" })).toBeInTheDocument();
    expect(screen.getByText("Demo · sample data")).toBeInTheDocument();
    expect(container.querySelector(".topbar-mid")?.textContent).toContain("3 waves");
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
    expect(await screen.findByText(/1 open decisions/)).toBeInTheDocument();
    expect(screen.getByText("waiting for wave state")).toBeInTheDocument();
    expect(container.querySelector(".topbar-mid")?.textContent).toContain("1 waves");
  });
});
