import { readFileSync } from "node:fs";
import path from "node:path";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import App from "../src/App";
import { ClaimButton, SteerPanel } from "../src/steer/SteerPanel";
import type { ControlReply, SteerTransport } from "../src/steer/transport";
import { CREDENTIALS_STORAGE_KEY, DeskStoreProvider, readCredentials } from "../src/store/context";
import type { DeskMqttClient } from "../src/store/mqtt-client";
import type { DeskMessage, Envelope } from "../src/store/types";

const noop = () => {};

describe("SteerPanel (writable)", () => {
  it("quick pills send their text in Mailbox mode", () => {
    const onSend = vi.fn();
    render(
      <SteerPanel target="T2 · implementer" coordinator={false} onSend={onSend} onClose={noop} />,
    );
    expect(screen.getByRole("dialog", { name: "Message T2 · implementer" })).toHaveTextContent(
      "Steer T2 · implementer",
    );
    fireEvent.click(screen.getByRole("button", { name: "Wrap up and publish done" }));
    expect(onSend).toHaveBeenCalledWith("Wrap up and publish done", false);
  });

  it("coordinator pills and copy", () => {
    const onSend = vi.fn();
    render(<SteerPanel target="status-chip" coordinator onSend={onSend} onClose={noop} />);
    expect(screen.getByText("Message the coordinator of status-chip")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Give me a status summary" }));
    expect(onSend).toHaveBeenCalledWith("Give me a status summary", false);
    expect(screen.getByRole("textbox", { name: "Prompt" })).toHaveAttribute(
      "placeholder",
      "Answer or instruct the coordinator…",
    );
  });

  it("typing / opens the command menu with the four commands", () => {
    render(
      <SteerPanel target="T2 · implementer" coordinator={false} onSend={noop} onClose={noop} />,
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Prompt" }), { target: { value: "/" } });
    const menu = screen.getByRole("listbox", { name: "Commands" });
    expect(
      within(menu)
        .getAllByRole("option")
        .map((o) => o.querySelector(".prompt-bar__row-name")?.textContent),
    ).toEqual(["/stop", "/wrap-up", "/pause", "/status"]);
  });

  it("sends typed text, urgent when the Urgent mode is picked", () => {
    const onSend = vi.fn();
    render(
      <SteerPanel target="T2 · implementer" coordinator={false} onSend={onSend} onClose={noop} />,
    );
    const box = screen.getByRole("textbox", { name: "Prompt" });
    fireEvent.change(box, { target: { value: "keep the rename out" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(onSend).toHaveBeenLastCalledWith("keep the rename out", false);

    fireEvent.click(screen.getByRole("button", { name: "Choose model" }));
    fireEvent.click(screen.getByRole("option", { name: /Urgent/ }));
    fireEvent.change(box, { target: { value: "rebase first" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(onSend).toHaveBeenLastCalledWith("rebase first", true);
  });

  it("shows the three delivery steps for the last message", () => {
    const { rerender } = render(
      <SteerPanel
        target="T2 · implementer"
        coordinator={false}
        onSend={noop}
        onClose={noop}
        last={{ text: "keep the rename out", state: "delivered" }}
      />,
    );
    const steps = () =>
      [...screen.getByRole("list", { name: "Delivery" }).querySelectorAll("li")].map(
        (li) => `${li.textContent}${li.classList.contains("on") ? "+" : ""}`,
      );
    expect(steps()).toEqual(["Sent+", "Delivered by hook+", "Agent acknowledged"]);
    expect(screen.getByText("“keep the rename out”")).toBeInTheDocument();
    rerender(
      <SteerPanel
        target="status-chip"
        coordinator
        onSend={noop}
        onClose={noop}
        last={{ text: "merge T2", state: "acked" }}
      />,
    );
    expect(steps()).toEqual(["Sent+", "Shown in your Claude session+", "Coordinator replied+"]);
    rerender(
      <SteerPanel
        target="T2 · implementer"
        coordinator={false}
        onSend={noop}
        onClose={noop}
        last={{ text: "x", state: "failed", error: "not authorised" }}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Not sent: not authorised");
  });

  it("says whether an urgent message interrupted the session", () => {
    const at = (last: Parameters<typeof SteerPanel>[0]["last"]) =>
      render(
        <SteerPanel target="T2" coordinator={false} onSend={noop} onClose={noop} last={last} />,
      );
    const a = at({ text: "x", state: "sending", urgent: true });
    expect(screen.getByText("Interrupting (Escape)…")).toBeInTheDocument();
    // The first step shows as pending while the publish waits for its PUBACK.
    expect(screen.getByRole("list", { name: "Delivery" }).querySelector("li")).toHaveClass(
      "pending",
    );
    a.unmount();
    const b = at({ text: "x", state: "sent", urgent: true, interrupt: { interrupted: true } });
    expect(screen.getByText("Interrupted (Escape), then delivered")).toBeInTheDocument();
    b.unmount();
    at({
      text: "x",
      state: "sent",
      urgent: true,
      interrupt: { interrupted: false, reason: "volleyd has no interrupt for this agent" },
    });
    expect(
      screen.getByText("Delivered (not interrupted: volleyd has no interrupt for this agent)"),
    ).toBeInTheDocument();
  });

  it("closes", () => {
    const onClose = vi.fn();
    render(<SteerPanel target="T2" coordinator={false} onSend={noop} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalled();
  });
});

describe("SteerPanel (no broker credentials)", () => {
  it("is read-only and the copy button yields the exact volleyd steer command", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(
      <SteerPanel
        target="T2 · implementer"
        coordinator={false}
        onSend={null}
        copy={{ wave: "status-chip", task: "T2" }}
        onClose={noop}
      />,
    );
    expect(screen.queryByRole("textbox", { name: "Prompt" })).toBeNull();
    expect(screen.getByText(/Read-only/)).toBeInTheDocument();

    // A pill fills the text instead of sending.
    fireEvent.click(screen.getByRole("button", { name: "Post a progress update now" }));
    const text = screen.getByRole("textbox", { name: "Steering text" });
    expect(text).toHaveValue("Post a progress update now");
    fireEvent.change(text, { target: { value: 'keep the "rename" out' } });

    const copy = screen.getByRole("button", { name: /^Copy "volleyd steer status-chip T2/ });
    fireEvent.click(copy);
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(
        `volleyd steer status-chip T2 'keep the "rename" out'`,
      ),
    );
    expect(await screen.findByText("Copied")).toBeInTheDocument();
  });

  it("a coordinator or an agent without a task offers no command, only the note", () => {
    render(<SteerPanel target="status-chip" coordinator onSend={null} onClose={noop} />);
    expect(screen.getByText(/Read-only/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Copy/ })).toBeNull();
  });
});

describe("SteerPanel with no one to message", () => {
  it("says why instead of the credentials note", () => {
    render(
      <SteerPanel
        target="leaderboard"
        coordinator
        onSend={null}
        readOnlyReason="This wave has no coordinator to message. Claim it first."
        onClose={noop}
      />,
    );
    expect(
      screen.getByText("This wave has no coordinator to message. Claim it first."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/anonymously/)).toBeNull();
  });
});

describe("ClaimButton", () => {
  const transport = (reply: Promise<ControlReply>) =>
    ({ identity: "desk", send: vi.fn(), control: vi.fn(() => reply) }) as unknown as SteerTransport;

  it("sends volleyd claim as a daemon control request and reports the new owner", async () => {
    const t = transport(Promise.resolve({ ok: true, result: { owner: "desk" } }));
    render(<ClaimButton wave="leaderboard" transport={t} />);
    fireEvent.click(screen.getByRole("button", { name: "Claim this wave" }));
    expect(t.control).toHaveBeenCalledWith(
      "claim",
      { wave: "leaderboard" },
      "volleyd claim leaderboard",
    );
    expect(await screen.findByText("Claimed: desk now owns leaderboard")).toBeInTheDocument();
  });

  it("shows the daemon's refusal", async () => {
    const t = transport(Promise.resolve({ ok: false, error: "owned by coordinator-x" }));
    render(<ClaimButton wave="w" transport={t} />);
    fireEvent.click(screen.getByRole("button", { name: "Claim this wave" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Claim refused: owned by coordinator-x",
    );
    expect(screen.getByRole("button", { name: "Claim this wave" })).toBeEnabled();
  });

  it("a request that never reached the broker is 'not sent', not 'refused'", async () => {
    const t = transport(
      Promise.resolve({ ok: false, error: "not connected to the broker", unsent: true }),
    );
    render(<ClaimButton wave="w" transport={t} />);
    fireEvent.click(screen.getByRole("button", { name: "Claim this wave" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Claim not sent: not connected to the broker",
    );
  });

  it("renders nothing without a write transport (the copy command stays)", () => {
    const { container } = render(<ClaimButton wave="w" transport={null} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("Desk steering end to end (live store)", () => {
  const waveState = JSON.parse(
    readFileSync(
      path.resolve(__dirname, "../../../spec/examples/valid/wave-state-running.json"),
      "utf8",
    ),
  ) as Envelope;
  const AGENT = "w1-t1-implementer-1";
  const registry: DeskMessage = {
    topic: `volley/_system/registry/${AGENT}`,
    receivedAt: 1,
    envelope: {
      schema_version: "0.1",
      agent_id: AGENT,
      namespace: "default",
      channel: "_system/registry",
      type: "registered",
      payload: { capabilities: [], started_at: "2026-10-18T14:00:00.000Z" },
    },
  };

  function fakeBroker({
    connects = true,
    state = waveState,
  }: { connects?: boolean; state?: Envelope } = {}) {
    const handlers = new Set<(m: DeskMessage) => void>();
    const published: { topic: string; envelope: Envelope }[] = [];
    const deliver = (m: DeskMessage) => {
      for (const h of handlers) h(m);
    };
    const auths: unknown[] = [];
    const factory = (_url: string, auth?: unknown): DeskMqttClient => {
      auths.push(auth);
      const none = () => () => {};
      let connected = () => {};
      return {
        connect: async () => {
          setTimeout(() => {
            if (connects) connected();
            deliver({ topic: "volley/_waves/w1/state", envelope: state, receivedAt: 1 });
            deliver(registry);
          }, 0);
        },
        disconnect: async () => {},
        publish: async (topic, payload) => {
          published.push({ topic, envelope: JSON.parse(payload) as Envelope });
        },
        onMessage: (h) => {
          handlers.add(h);
          return () => handlers.delete(h);
        },
        onConnect: (h) => {
          connected = h;
          return () => {};
        },
        onDisconnect: none,
        onError: none,
      };
    };
    return { factory, published, deliver, auths };
  }

  it("signed in: a pill publishes steering as the Desk; the hook ack and steering_acked light the steps", async () => {
    const b = fakeBroker();
    render(
      <DeskStoreProvider
        demo={false}
        brokerUrl="ws://test.invalid"
        auth={{ username: "desk", password: "pw" }}
        clientFactory={b.factory}
      >
        <App />
      </DeskStoreProvider>,
    );
    expect(b.auths[0]).toEqual({ username: "desk", password: "pw" });
    fireEvent.click(await screen.findByRole("button", { name: "Message T1 implementer" }));
    const panel = screen.getByRole("dialog", { name: "Message T1 · implementer" });
    fireEvent.click(within(panel).getByRole("button", { name: "Post a progress update now" }));

    await waitFor(() => expect(b.published).toHaveLength(1));
    const sent = b.published[0];
    expect(sent?.topic).toBe(`volley/default/${AGENT}/mailbox`);
    expect(sent?.envelope).toMatchObject({
      agent_id: "desk",
      type: "steering",
      payload: { text: "Post a progress update now", seq: 1 },
    });
    const lit = () =>
      [...within(panel).getByRole("list", { name: "Delivery" }).querySelectorAll("li.on")].map(
        (li) => li.textContent,
      );
    await waitFor(() => expect(lit()).toEqual(["Sent"]));

    const id = sent?.envelope.correlation_id ?? null;
    act(() =>
      b.deliver({
        topic: "volley/default/desk/mailbox",
        receivedAt: Date.now(),
        envelope: {
          schema_version: "0.1",
          agent_id: AGENT,
          channel: "mailbox",
          type: "ack",
          correlation_id: id,
          payload: { text: "ACKED", acked_type: "steering", seq: 1 },
        },
      }),
    );
    await waitFor(() => expect(lit()).toEqual(["Sent", "Delivered by hook"]));
    act(() =>
      b.deliver({
        topic: `volley/default/${AGENT}/progress`,
        receivedAt: Date.now(),
        envelope: {
          schema_version: "0.1",
          agent_id: AGENT,
          channel: "progress",
          type: "steering_acked",
          correlation_id: id,
          payload: { msg: "acknowledged: posting an update" },
        },
      }),
    );
    await waitFor(() => expect(lit()).toEqual(["Sent", "Delivered by hook", "Agent acknowledged"]));
    // The Desk's own mailbox never becomes an agent window.
    expect(screen.queryByRole("region", { name: "desk" })).toBeNull();
  });

  const signedIn = (b: ReturnType<typeof fakeBroker>) =>
    render(
      <DeskStoreProvider
        demo={false}
        brokerUrl="ws://test.invalid"
        auth={{ username: "desk", password: "pw" }}
        clientFactory={b.factory}
      >
        <App />
      </DeskStoreProvider>,
    );

  it("the wave chat messages the live coordinator session", async () => {
    const p = waveState.payload as Record<string, unknown>;
    const live = {
      ...waveState,
      payload: {
        ...p,
        coordinator: {
          ...(p.coordinator as Record<string, unknown>),
          last_seen: new Date().toISOString(),
        },
      },
    } as Envelope;
    const b = fakeBroker({ state: live });
    signedIn(b);
    fireEvent.click(await screen.findByRole("button", { name: "Message the coordinator of w1" }));
    const panel = screen.getByRole("dialog", { name: "Message w1" });
    fireEvent.click(within(panel).getByRole("button", { name: "Give me a status summary" }));
    await waitFor(() => expect(b.published).toHaveLength(1));
    expect(b.published[0]?.topic).toBe("volley/default/coordinator-ab12/mailbox");
  });

  it("after the Desk claims the wave, the wave chat is read-only and sends nothing to itself", async () => {
    const claimed = {
      ...waveState,
      payload: { ...(waveState.payload as Record<string, unknown>), owner: "desk" },
    } as Envelope;
    const b = fakeBroker({ state: claimed });
    signedIn(b);
    fireEvent.click(await screen.findByRole("button", { name: "Message the coordinator of w1" }));
    const panel = screen.getByRole("dialog", { name: "Message w1" });
    expect(
      within(panel).getByText("You own this wave; there is no coordinator session to message."),
    ).toBeInTheDocument();
    expect(within(panel).queryByRole("list", { name: "Delivery" })).toBeNull();
    fireEvent.click(within(panel).getByRole("button", { name: "Give me a status summary" }));
    expect(b.published).toHaveLength(0);
  });

  it("credentials that never connect leave the panel read-only", async () => {
    const b = fakeBroker({ connects: false });
    signedIn(b);
    fireEvent.click(await screen.findByRole("button", { name: "Message T1 implementer" }));
    const panel = screen.getByRole("dialog", { name: "Message T1 · implementer" });
    expect(within(panel).getByText(/Read-only/)).toBeInTheDocument();
    fireEvent.click(within(panel).getByRole("button", { name: "Post a progress update now" }));
    expect(b.published).toHaveLength(0);
  });

  it("anonymous: the panel is read-only with the volleyd steer copy command", async () => {
    const b = fakeBroker();
    render(
      <DeskStoreProvider
        demo={false}
        brokerUrl="ws://test.invalid"
        auth={null}
        clientFactory={b.factory}
      >
        <App />
      </DeskStoreProvider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Message T1 implementer" }));
    const panel = screen.getByRole("dialog", { name: "Message T1 · implementer" });
    expect(within(panel).getByText(/Read-only/)).toBeInTheDocument();
    expect(
      within(panel).getByRole("button", { name: /^Copy "volleyd steer w1 T1/ }),
    ).toBeInTheDocument();
    fireEvent.click(within(panel).getByRole("button", { name: "Post a progress update now" }));
    expect(b.published).toHaveLength(0);
    expect(b.auths[0]).toBeUndefined();
  });
});

describe("Desk steering (demo mode)", () => {
  it("writes to the simulated client: sent, then the demo hook ack and agent acknowledgement", async () => {
    render(
      <DeskStoreProvider demo>
        <App />
      </DeskStoreProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Message T2 implementer" }));
    const panel = screen.getByRole("dialog", { name: "Message T2 · implementer" });
    fireEvent.click(within(panel).getByRole("button", { name: "Keep the rename out of this PR" }));
    const lit = () =>
      [...within(panel).getByRole("list", { name: "Delivery" }).querySelectorAll("li.on")].length;
    await waitFor(() => expect(lit()).toBe(1));
    await waitFor(() => expect(lit()).toBe(3), { timeout: 4000 });
    // The demo "agent" acknowledged through the same reducer the live path uses.
    expect(panel.closest(".win")).toHaveTextContent(/Acknowledged: keep the rename out of this pr/);
  });
});

describe("readCredentials", () => {
  const store = (v: unknown) => ({
    getItem: (k: string) => (k === CREDENTIALS_STORAGE_KEY ? JSON.stringify(v) : null),
  });

  it("accepts a username in the agent-id grammar", () => {
    expect(readCredentials({}, store({ username: "desk", password: "pw" }))).toEqual({
      username: "desk",
      password: "pw",
    });
  });

  it("a username that is not a valid agent id stays anonymous (read-only), with a warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(
      readCredentials(
        { VITE_VOLLEY_BROKER_USERNAME: "Desk", VITE_VOLLEY_BROKER_PASSWORD: "x" },
        null,
      ),
    ).toBeNull();
    expect(readCredentials({}, store({ username: "ops@host", password: "pw" }))).toBeNull();
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
});
