/**
 * Phase 2 — Dashboard integration test.
 *
 * Wires a minimal in-process mock MQTT client into `<Dashboard />` via
 * `clientFactory`, feeds it a single registry envelope so an agent appears
 * in the grid, then verifies:
 *   - clicking the card opens the drawer
 *   - the drawer header surfaces the agent id
 *   - pressing Esc closes the drawer (mounted at dashboard level — handled
 *     by the keydown listener inside `DashboardShell`)
 *   - the grid behind the drawer stays mounted while the drawer is open
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Dashboard } from "../src/components/Dashboard";
import type {
  ErrorHandler,
  MessageHandler,
  VoidHandler,
  VolleyMqttClient,
} from "../src/lib/mqtt-client";
import { parseEnvelope } from "../src/lib/parse-envelope";

interface MockClient extends VolleyMqttClient {
  __emit: (topic: string, payload: string) => void;
}

function makeMockFactory(): {
  factory: (url: string) => VolleyMqttClient;
  client: () => MockClient;
} {
  let current: MockClient | null = null;
  const factory = (_url: string): VolleyMqttClient => {
    const msgHandlers = new Set<MessageHandler>();
    const connectHandlers = new Set<VoidHandler>();
    const disconnectHandlers = new Set<VoidHandler>();
    const errorHandlers = new Set<ErrorHandler>();
    const c: MockClient = {
      connect: async () => {
        for (const h of connectHandlers) h();
      },
      disconnect: async () => {
        for (const h of disconnectHandlers) h();
      },
      onMessage: (h) => {
        msgHandlers.add(h);
        return () => msgHandlers.delete(h);
      },
      onConnect: (h) => {
        connectHandlers.add(h);
        return () => connectHandlers.delete(h);
      },
      onDisconnect: (h) => {
        disconnectHandlers.add(h);
        return () => disconnectHandlers.delete(h);
      },
      onError: (h) => {
        errorHandlers.add(h);
        return () => errorHandlers.delete(h);
      },
      __emit: (topic, payload) => {
        const env = parseEnvelope(payload);
        if (env === null) return;
        for (const h of msgHandlers) h(topic, env);
      },
    };
    current = c;
    return c;
  };
  return { factory, client: () => current as MockClient };
}

describe("Dashboard integration", () => {
  function emitAgent(client: MockClient, id: string): void {
    const env = {
      schema_version: "1",
      agent_id: id,
      channel: "system",
      type: "registered",
      wall_time: new Date().toISOString(),
      parent_id: null,
      payload: {
        msg: "registered",
        progress: null,
        capabilities: ["test"],
      },
    };
    client.__emit(`volley/_system/registry/${id}`, JSON.stringify(env));
  }

  it("opens drawer on agent-card click", async () => {
    const { factory, client } = makeMockFactory();
    await act(async () => {
      render(<Dashboard brokerUrl="mock://test" clientFactory={factory} />);
    });
    await act(async () => {
      emitAgent(client(), "coordinator-test");
    });
    fireEvent.click(screen.getByTestId("agent-card-coordinator-test"));
    const drawer = screen.getByTestId("agent-drawer");
    expect(drawer).toBeInTheDocument();
    // Drawer header surfaces the agent id (use within() to scope the search
    // to the drawer — the id also appears in the card and inside the envelope).
    expect(drawer.querySelector(".vd-aid")?.textContent).toBe("coordinator-test");
  });

  it("Esc closes the drawer", async () => {
    const { factory, client } = makeMockFactory();
    await act(async () => {
      render(<Dashboard brokerUrl="mock://test" clientFactory={factory} />);
    });
    await act(async () => {
      emitAgent(client(), "agent-esc");
    });
    fireEvent.click(screen.getByTestId("agent-card-agent-esc"));
    expect(screen.getByTestId("agent-drawer")).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId("agent-drawer")).not.toBeInTheDocument();
  });

  it("grid stays mounted while drawer is open", async () => {
    const { factory, client } = makeMockFactory();
    await act(async () => {
      render(<Dashboard brokerUrl="mock://test" clientFactory={factory} />);
    });
    await act(async () => {
      emitAgent(client(), "agent-bg");
    });
    fireEvent.click(screen.getByTestId("agent-card-agent-bg"));
    expect(screen.getByTestId("agent-drawer")).toBeInTheDocument();
    // Grid still renders the card behind the drawer.
    expect(screen.getByTestId("agent-card-agent-bg")).toBeInTheDocument();
    expect(screen.getByTestId("agent-grid")).toBeInTheDocument();
  });

  it("shows EmptyState when no agents have registered", async () => {
    const { factory } = makeMockFactory();
    await act(async () => {
      render(<Dashboard brokerUrl="mock://test" clientFactory={factory} />);
    });
    expect(screen.getByTestId("empty-state")).toBeInTheDocument();
  });
});
