import { readFileSync } from "node:fs";
import path from "node:path";
import { act, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import App from "../src/App";
import { DeskStoreProvider } from "../src/store/context";
import type { DeskMqttClient } from "../src/store/mqtt-client";
import type { DeskMessage, Envelope } from "../src/store/types";

const wave = JSON.parse(
  readFileSync(
    path.resolve(__dirname, "../../../spec/examples/valid/wave-state-running.json"),
    "utf8",
  ),
) as Envelope;

function client(msgs: DeskMessage[]): DeskMqttClient {
  const handlers = new Set<(m: DeskMessage) => void>();
  const connected = new Set<() => void>();
  return {
    connect: async () => {
      for (const h of connected) h();
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
    onConnect: (h) => {
      connected.add(h);
      return () => connected.delete(h);
    },
    onDisconnect: () => () => {},
    onError: () => () => {},
  };
}

describe("a wave the Desk claimed (P2-11)", () => {
  it("is yours and no longer asks for a coordinator", async () => {
    const claimed: DeskMessage = {
      topic: "volley/_waves/w1/state",
      envelope: { ...wave, payload: { ...(wave.payload as object), owner: "desk" } },
      receivedAt: Date.now(),
      retained: true,
    };
    const c = client([claimed]);
    render(
      <DeskStoreProvider
        demo={false}
        brokerUrl="ws://test.invalid"
        auth={{ username: "desk", password: "pw" }}
        clientFactory={() => c}
        settleMs={10}
      >
        <App />
      </DeskStoreProvider>,
    );
    await act(async () => new Promise((r) => setTimeout(r, 40)));
    const coords = screen.getByRole("region", { name: "Wave coordinators" });
    expect(within(coords).getByText("★ yours")).toBeInTheDocument();
    expect(within(coords).queryByText(/No coordinator/)).not.toBeInTheDocument();
    expect(screen.queryByText(/No coordinator/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Claim/ })).not.toBeInTheDocument();
  });
});
