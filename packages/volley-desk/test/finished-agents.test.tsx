import { readFileSync } from "node:fs";
import path from "node:path";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import App from "../src/App";
import { DeskStoreProvider } from "../src/store/context";
import type { DeskMqttClient } from "../src/store/mqtt-client";
import type { DeskMessage, Envelope } from "../src/store/types";

const EXAMPLES = path.resolve(__dirname, "../../../spec/examples/valid");
const example = (name: string) =>
  JSON.parse(readFileSync(path.join(EXAMPLES, `${name}.json`), "utf8")) as Envelope;

const MIN = 60_000;

function retained(topic: string, envelope: Envelope): DeskMessage {
  return { topic, envelope, receivedAt: Date.now(), retained: true };
}

function registry(id: string): DeskMessage {
  return retained(`volley/_system/registry/${id}`, {
    ...example("registry-coordinator"),
    agent_id: id,
    namespace: "default",
  });
}

function status(id: string, type: string, agoMs: number): DeskMessage {
  return retained(`volley/default/${id}/status`, {
    schema_version: "0.1",
    agent_id: id,
    channel: "status",
    type,
    wall_time: new Date(Date.now() - agoMs).toISOString(),
    payload: {},
  });
}

function client(msgs: DeskMessage[]): DeskMqttClient {
  const handlers = new Set<(m: DeskMessage) => void>();
  return {
    connect: async () => {
      setTimeout(() => {
        for (const m of msgs) for (const h of handlers) h(m);
      }, 0);
    },
    disconnect: async () => {},
    publish: async () => {},
    onMessage: (h) => {
      handlers.add(h);
      return () => handlers.delete(h);
    },
    onConnect: () => () => {},
    onDisconnect: () => () => {},
    onError: () => () => {},
  };
}

const win = (name: string) => screen.queryByRole("region", { name });

describe("finished agents (owner live-data finding a)", () => {
  beforeEach(() => localStorage.clear());

  it("hides agents finished longer ago than the grace until 'Show finished agents' is on", async () => {
    const c = client([
      retained("volley/_waves/w1/state", example("wave-state-running")),
      registry("w1-t1-implementer-1"),
      registry("w1-t1-spec_reviewer-1"),
      registry("w1-t3-implementer-1"),
      status("w1-t1-implementer-1", "done", 40 * MIN),
      status("w1-t1-spec_reviewer-1", "working", 1 * MIN),
      status("w1-t3-implementer-1", "done", 2 * MIN),
    ]);
    render(
      <DeskStoreProvider demo={false} brokerUrl="ws://test.invalid" clientFactory={() => c}>
        <App />
      </DeskStoreProvider>,
    );
    await act(async () => new Promise((r) => setTimeout(r, 40)));

    expect(win("T1 · SPEC + schemas · spec review")).toBeInTheDocument();
    // Finished two minutes ago: inside the default 10 min grace.
    expect(win("T3 · Daemon foundation · implementer")).toBeInTheDocument();
    expect(win("T1 · SPEC + schemas · implementer")).not.toBeInTheDocument();

    const box = screen.getByRole("checkbox", { name: /Show finished agents/ });
    expect(screen.getByText(/1 finished more than 10 min ago is hidden/)).toBeInTheDocument();
    fireEvent.click(box);
    expect(win("T1 · SPEC + schemas · implementer")).toBeInTheDocument();
    fireEvent.click(box);
    expect(win("T1 · SPEC + schemas · implementer")).not.toBeInTheDocument();
  });
});
