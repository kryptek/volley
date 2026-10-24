import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../src/App";
import { LOOK0 } from "../src/look/useLook";
import { SLIDER_COMMIT_MS } from "../src/settings/ConfigRows";
import { SettingsModal } from "../src/settings/SettingsModal";
import { SettingsWindow } from "../src/settings/SettingsWindow";
import { Supervisor } from "../src/settings/Supervisor";
import {
  type ConfigClient,
  type ConfigTransport,
  copyCommand,
  createConfigTransport,
} from "../src/settings/configTransport";
import { DeskStoreProvider } from "../src/store/context";
import type { DeskMqttClient } from "../src/store/mqtt-client";
import type { ConfigPayload, DeskMessage, Envelope, WaveView } from "../src/store/types";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const config: ConfigPayload = {
  version: 7,
  updated_at: "2026-10-18T12:00:00.000Z",
  updated_by: "volleyd-defaults",
  hard_ceiling: 12,
  spawn_budget_multiplier: 3,
  lease_pools: { build: { capacity: 2, ttl_s: 1800, match: ["npm run build"] } },
  admission: {
    memory_pressure_max_level: 2,
    cmux_ping_max_ms: 1500,
    container_max: 20,
    api_overload_window_s: 300,
    api_overload_max: 3,
    ci_queue_max: 10,
    hysteresis_samples: 3,
  },
  claim_after_s: 1800,
  heartbeat_alarm_s: 600,
  fallback_model: "claude-sonnet-5-5",
  mailbox: { session_expiry_s: 604800 },
  worktree_root: "/tmp/volley worktrees",
  agent_mcp_allow: [],
  spawn_timeout_s: 180,
  wake_grace_s: 120,
};

function wave(): WaveView {
  return {
    id: "status-chip",
    receivedAt: 0,
    decisions: {},
    state: {
      wave: "status-chip",
      version: 1,
      owner: "coordinator-desk1",
      repo: "example-org/example-repo",
      release_branch: "release/2026-10-20-status-chip",
      status: "running",
      tasks: [],
      open_decisions: [],
      gates: [],
      effective_config: { ...config, hard_ceiling: 4 },
      updated_at: "2026-10-18T12:00:00.000Z",
    },
  };
}

/** A fake broker client: records publishes and lets the test deliver messages. */
function fakeClient() {
  const published: { topic: string; envelope: Envelope }[] = [];
  const handlers = new Set<(m: DeskMessage) => void>();
  const client: ConfigClient = {
    publish: vi.fn(async (topic: string, payload: string) => {
      published.push({ topic, envelope: JSON.parse(payload) as Envelope });
    }),
    onMessage: (h) => {
      handlers.add(h);
      return () => handlers.delete(h);
    },
  };
  const deliver = (topic: string, envelope: Envelope) =>
    act(async () => {
      for (const h of handlers) h({ topic, envelope, receivedAt: Date.now() });
    });
  const ack = (correlationId: string, payload: Record<string, unknown>) =>
    deliver("volley/default/desk/mailbox", {
      schema_version: "0.1",
      agent_id: "volleyd",
      channel: "mailbox",
      type: "ack",
      wall_time: "2026-10-18T12:00:01.000Z",
      correlation_id: correlationId,
      payload: { text: "config_set", acked_type: "query", op: "config_set", ...payload },
    });
  return { client, published, deliver, ack, handlers };
}

/** Settings › Supervisor: the global config rows, one group's page (Admission first). */
function setup(transport: ConfigTransport | null, first = "admission") {
  let group = first;
  let values = config;
  const page = () => <Supervisor config={values} transport={transport} group={group} />;
  const view = render(page());
  const retain = (next: ConfigPayload) => {
    values = next;
    view.rerender(page());
  };
  /** Another group's page of the same section. */
  const show = (next: string) => {
    group = next;
    view.rerender(page());
  };
  return { retain, show };
}

const slider = (name: string) => screen.getByRole("slider", { name });
const rowOf = (name: string) => slider(name).closest(".cfg-row") as HTMLElement;
const flush = () => act(async () => {});
/** Let the slider's commit window pass: the settled value is sent. */
const settle = () =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(SLIDER_COMMIT_MS);
  });
const press = (name: string, key: string, times = 1) => {
  for (let i = 0; i < times; i++) fireEvent.keyDown(slider(name), { key });
};
const ids = (f: ReturnType<typeof fakeClient>) =>
  f.published.map((p) => p.envelope.correlation_id as string);
const applied = (version: number) => ({
  ok: true,
  applied: true,
  rejected: [],
  result: { version },
});

function setClipboard(value: unknown) {
  Object.defineProperty(navigator, "clipboard", { value, configurable: true });
}
function setExecCommand(fn: ((cmd: string) => boolean) | undefined) {
  Object.defineProperty(document, "execCommand", { value: fn, configurable: true });
}

describe("Settings › Supervisor (global config rows)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });
  afterEach(() => {
    vi.useRealTimers();
    setClipboard(undefined);
    setExecCommand(undefined);
  });

  it("builds its groups' pages from the schema and shows the current global values", () => {
    const { show } = setup(null);
    expect(slider("Hard ceiling")).toHaveAttribute("aria-valuenow", "12");
    expect(slider("Hard ceiling")).toHaveAttribute("aria-valuemax", "100");
    expect(
      screen.getByText(
        "Runaway fuse: maximum concurrently live supervised agents across all waves.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(/applies at the next admission tick/)).toHaveTextContent(
      "Saved through volleyd config set · applies at the next admission tick · never preempts running work",
    );
    show("leases");
    expect(screen.getByRole("heading", { name: "Leases" })).toBeInTheDocument();
    expect(slider("build pool capacity")).toHaveAttribute("aria-valuenow", "2");
    show("recovery");
    expect(screen.queryByRole("slider", { name: "Hard ceiling" })).toBeNull();
    expect(screen.getByRole("textbox", { name: "Fallback model" })).toHaveValue(
      "claude-sonnet-5-5",
    );
  });

  it("moving the hard-ceiling slider sends config_set to the daemon's mailbox and shows the ack", async () => {
    const f = fakeClient();
    setup(createConfigTransport(f.client, { identity: "desk" }));
    press("Hard ceiling", "ArrowRight");
    await flush();
    expect(f.published).toHaveLength(0);
    await settle();

    expect(f.published).toHaveLength(1);
    const [{ topic, envelope }] = f.published as [(typeof f.published)[number]];
    expect(topic).toBe("volley/default/volleyd/mailbox");
    expect(envelope).toMatchObject({
      schema_version: "0.1",
      agent_id: "desk",
      channel: "mailbox",
      type: "query",
      payload: { op: "config_set", patch: { hard_ceiling: 13 }, by: "desk" },
    });
    expect(envelope.correlation_id).toMatch(UUID);
    expect((envelope.payload as Record<string, unknown>).text).toBe("config_set hard_ceiling=13");
    expect(envelope.payload).not.toHaveProperty("wave");
    expect(within(rowOf("Hard ceiling")).getByText("sending…")).toBeInTheDocument();

    await f.ack(envelope.correlation_id as string, {
      ok: true,
      applied: true,
      rejected: [],
      result: { version: 8 },
    });
    expect(within(rowOf("Hard ceiling")).getByText("applied · v8")).toBeInTheDocument();
    expect(slider("Hard ceiling")).toHaveAttribute("aria-valuenow", "13");
  });

  it("shows a rejected ack's reasons inline and returns the slider to the current value", async () => {
    const f = fakeClient();
    setup(createConfigTransport(f.client, { identity: "desk" }), "leases");
    press("build pool capacity", "ArrowLeft");
    await settle();
    const { envelope } = f.published[0] as (typeof f.published)[number];
    expect(envelope.payload).toMatchObject({ patch: { lease_pools: { build: { capacity: 1 } } } });

    // A reply for someone else's request changes nothing.
    await f.ack("00000000-0000-4000-8000-000000000000", { ok: true, applied: true, rejected: [] });
    expect(within(rowOf("build pool capacity")).getByText("sending…")).toBeInTheDocument();

    await f.ack(envelope.correlation_id as string, {
      ok: false,
      applied: false,
      rejected: [{ path: "lease_pools.build.capacity", reason: "must be >= 2 while held" }],
    });
    const alert = within(rowOf("build pool capacity")).getByRole("alert");
    expect(alert).toHaveTextContent(
      "rejected · lease_pools.build.capacity: must be >= 2 while held",
    );
    expect(slider("build pool capacity")).toHaveAttribute("aria-valuenow", "2");
  });

  it("sends one config_set for a burst of key presses, with the value the user settled on", async () => {
    const f = fakeClient();
    setup(createConfigTransport(f.client, { identity: "desk" }));
    press("Hard ceiling", "ArrowRight", 8);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SLIDER_COMMIT_MS - 1);
    });
    expect(f.published).toHaveLength(0);
    expect(slider("Hard ceiling")).toHaveAttribute("aria-valuenow", "20");
    await settle();
    expect(f.published).toHaveLength(1);
    expect(f.published[0]?.envelope.payload).toMatchObject({ patch: { hard_ceiling: 20 } });
  });

  it("shows the answer to the latest change of a row, not an older one that answers late", async () => {
    const f = fakeClient();
    setup(createConfigTransport(f.client, { identity: "desk" }));
    press("Hard ceiling", "ArrowRight");
    await settle();
    press("Hard ceiling", "ArrowRight");
    await settle();
    const [first, second] = ids(f);
    expect(f.published[1]?.envelope.payload).toMatchObject({ patch: { hard_ceiling: 14 } });
    await f.ack(second as string, applied(9));
    await f.ack(first as string, {
      ok: false,
      applied: false,
      rejected: [{ path: "hard_ceiling", reason: "superseded" }],
    });
    expect(within(rowOf("Hard ceiling")).getByText("applied · v9")).toBeInTheDocument();
    expect(slider("Hard ceiling")).toHaveAttribute("aria-valuenow", "14");
  });

  it("sends a revert to the retained value while the change away from it is in flight", async () => {
    const f = fakeClient();
    setup(createConfigTransport(f.client, { identity: "desk" }));
    press("Hard ceiling", "ArrowRight");
    await settle();
    press("Hard ceiling", "ArrowLeft");
    // The answer to 13 lands before the revert is sent: it must not read "applied" next to 12.
    await f.ack(ids(f)[0] as string, applied(8));
    expect(within(rowOf("Hard ceiling")).queryByText("applied · v8")).not.toBeInTheDocument();
    expect(slider("Hard ceiling")).toHaveAttribute("aria-valuenow", "12");

    await settle();
    expect(f.published.map((p) => p.envelope.payload)).toMatchObject([
      { patch: { hard_ceiling: 13 } },
      { patch: { hard_ceiling: 12 } },
    ]);
    expect(within(rowOf("Hard ceiling")).getByText("sending…")).toBeInTheDocument();
    await f.ack(ids(f)[1] as string, applied(9));
    expect(within(rowOf("Hard ceiling")).getByText("applied · v9")).toBeInTheDocument();
    expect(slider("Hard ceiling")).toHaveAttribute("aria-valuenow", "12");
  });

  it("returning to the value in flight cancels the queued change and keeps that answer", async () => {
    const f = fakeClient();
    setup(createConfigTransport(f.client, { identity: "desk" }));
    press("Hard ceiling", "ArrowRight");
    await settle();
    press("Hard ceiling", "ArrowLeft");
    press("Hard ceiling", "ArrowRight");
    await settle();
    expect(f.published).toHaveLength(1);
    await f.ack(ids(f)[0] as string, applied(8));
    expect(within(rowOf("Hard ceiling")).getByText("applied · v8")).toBeInTheDocument();
    expect(slider("Hard ceiling")).toHaveAttribute("aria-valuenow", "13");
  });

  it("keeps a row's change in flight when the retained config changes another row", async () => {
    const f = fakeClient();
    const { retain } = setup(createConfigTransport(f.client, { identity: "desk" }));
    press("Hard ceiling", "ArrowRight");
    await settle();
    retain({ ...config, version: 8, spawn_budget_multiplier: 4 });
    expect(slider("Spawn budget")).toHaveAttribute("aria-valuenow", "4");
    expect(slider("Hard ceiling")).toHaveAttribute("aria-valuenow", "13");
    expect(within(rowOf("Hard ceiling")).getByText("sending…")).toBeInTheDocument();

    // Its own value retained: the row shows it, whatever order the ack comes in.
    retain({ ...config, version: 9, spawn_budget_multiplier: 4, hard_ceiling: 13 });
    await f.ack(ids(f)[0] as string, applied(9));
    expect(slider("Hard ceiling")).toHaveAttribute("aria-valuenow", "13");
    retain({ ...config, version: 10, claim_after_s: 900, hard_ceiling: 15 });
    expect(slider("Hard ceiling")).toHaveAttribute("aria-valuenow", "15");
  });

  it("labels an unanswered request as unknown and keeps the value", async () => {
    const f = fakeClient();
    setup(createConfigTransport(f.client, { identity: "desk", timeoutMs: 1000 }));
    press("Hard ceiling", "ArrowRight");
    await settle();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    const row = within(rowOf("Hard ceiling"));
    expect(row.getByRole("alert")).toHaveTextContent(
      "no answer · volleyd did not answer within 1s",
    );
    expect(row.queryByText(/rejected/)).not.toBeInTheDocument();
    expect(slider("Hard ceiling")).toHaveAttribute("aria-valuenow", "13");
  });

  it("labels a refused publish as failed and returns the slider", async () => {
    const refusing: ConfigClient = {
      ...fakeClient().client,
      publish: async () => {
        throw new Error("not authorised");
      },
    };
    setup(createConfigTransport(refusing, { identity: "desk" }));
    press("Hard ceiling", "ArrowRight");
    await settle();
    expect(within(rowOf("Hard ceiling")).getByRole("alert")).toHaveTextContent(
      "failed · not authorised",
    );
    expect(slider("Hard ceiling")).toHaveAttribute("aria-valuenow", "12");
  });

  it("puts a multiplier's × right after the value", () => {
    const { show } = setup(null);
    expect(within(rowOf("Spawn budget")).getByText("3×")).toBeInTheDocument();
    show("attention");
    expect(within(rowOf("Claim after")).getByText("1800 s")).toBeInTheDocument();
  });

  it("sends a text tunable on Enter, empty meaning null when the schema allows it", async () => {
    const f = fakeClient();
    setup(createConfigTransport(f.client, { identity: "desk" }), "recovery");
    const box = screen.getByRole("textbox", { name: "Fallback model" });
    fireEvent.change(box, { target: { value: "" } });
    fireEvent.keyDown(box, { key: "Enter" });
    await flush();
    expect(f.published[0]?.envelope.payload).toMatchObject({ patch: { fallback_model: null } });
  });

  it("sends a list tunable (agent_mcp_allow) on Enter, as distinct trimmed names", async () => {
    const f = fakeClient();
    setup(createConfigTransport(f.client, { identity: "desk" }), "other");
    const box = screen.getByRole("textbox", { name: "Agent MCP allow" });
    fireEvent.change(box, { target: { value: "migrations, playwright,, migrations " } });
    fireEvent.keyDown(box, { key: "Enter" });
    await flush();
    expect(f.published[0]?.envelope.payload).toMatchObject({
      patch: { agent_mcp_allow: ["migrations", "playwright"] },
    });
  });

  it("does not send a list tunable over the schema's bounds; the field says why", async () => {
    const f = fakeClient();
    setup(createConfigTransport(f.client, { identity: "desk" }), "other");
    const box = screen.getByRole("textbox", { name: "Agent MCP allow" });
    fireEvent.change(box, { target: { value: `ok, ${"x".repeat(129)}` } });
    fireEvent.keyDown(box, { key: "Enter" });
    await flush();
    expect(box.getAttribute("aria-invalid")).toBe("true");
    expect(box.getAttribute("title")).toMatch(/at most 128 characters/);
    const many = Array.from({ length: 65 }, (_, i) => `s${i}`).join(", ");
    fireEvent.change(box, { target: { value: many } });
    fireEvent.keyDown(box, { key: "Enter" });
    await flush();
    expect(box.getAttribute("title")).toMatch(/at most 64 names/);
    expect(f.published).toHaveLength(0);
  });

  it("clears a list tunable's over-bounds mark when the retained value changes elsewhere", async () => {
    const f = fakeClient();
    const { retain } = setup(createConfigTransport(f.client, { identity: "desk" }), "other");
    const box = screen.getByRole("textbox", { name: "Agent MCP allow" });
    fireEvent.change(box, { target: { value: "x".repeat(129) } });
    fireEvent.keyDown(box, { key: "Enter" });
    await flush();
    expect(box.getAttribute("aria-invalid")).toBe("true");
    retain({ ...config, agent_mcp_allow: ["playwright"] });
    await flush();
    expect((box as HTMLInputElement).value).toBe("playwright");
    expect(box.getAttribute("aria-invalid")).toBe("false");
    expect(box.getAttribute("title")).toBeNull();
  });

  it("sends a switch tunable on a click and a choice tunable on a pick", async () => {
    const f = fakeClient();
    const fleet = { ...config, require_fresh_base: true, placement: { nudge_on_merge: "files" } };
    render(
      <Supervisor
        config={fleet}
        transport={createConfigTransport(f.client, { identity: "desk" })}
        group="other"
      />,
    );
    fireEvent.click(screen.getByRole("switch", { name: "Require fresh base" }));
    await flush();
    expect(f.published[0]?.envelope.payload).toMatchObject({
      patch: { require_fresh_base: false },
    });
    fireEvent.change(screen.getByRole("combobox", { name: "Placement nudge on merge" }), {
      target: { value: "off" },
    });
    await flush();
    expect(f.published[1]?.envelope.payload).toMatchObject({
      patch: { placement: { nudge_on_merge: "off" } },
    });
  });

  it("without credentials a row drafts a new value and copies the command that sets it (P3-14)", async () => {
    const writeText = vi.fn(async () => {});
    setClipboard({ writeText });
    const f = fakeClient();
    const { show } = setup(null);
    expect(screen.getByText(/read-only/i)).toBeInTheDocument();

    // Until the value changes there is nothing to copy: re-setting the current value does nothing.
    const row = rowOf("Hard ceiling");
    expect(within(row).queryByRole("button", { name: "Copy command" })).not.toBeInTheDocument();
    expect(within(row).getByText(/Pick a new value to copy its command/)).toBeInTheDocument();
    expect(screen.queryByText("volleyd config set hard_ceiling 12")).not.toBeInTheDocument();

    press("Hard ceiling", "ArrowRight");
    await settle();
    expect(slider("Hard ceiling")).toHaveAttribute("aria-valuenow", "13");
    expect(within(row).getByText("volleyd config set hard_ceiling 13")).toBeInTheDocument();
    fireEvent.click(within(row).getByRole("button", { name: "Copy command" }));
    await flush();
    expect(writeText).toHaveBeenCalledWith("volleyd config set hard_ceiling 13");
    expect(within(row).getByRole("button", { name: "Copy command" })).toHaveTextContent("Copied");
    expect(f.published).toHaveLength(0);

    // Back to the current value: nothing to copy again.
    press("Hard ceiling", "ArrowLeft");
    await settle();
    expect(within(row).queryByRole("button", { name: "Copy command" })).not.toBeInTheDocument();

    show("recovery");
    const root = screen.getByRole("textbox", { name: "Worktree root" });
    fireEvent.change(root, { target: { value: "/srv/wt" } });
    fireEvent.keyDown(root, { key: "Enter" });
    expect(screen.getByText("volleyd config set worktree_root /srv/wt")).toBeInTheDocument();
  });

  it("a missing global config shows a note and no rows", () => {
    render(<Supervisor config={null} transport={null} group="admission" />);
    expect(screen.getByText("No config from volleyd yet.")).toBeInTheDocument();
    expect(screen.queryAllByRole("slider")).toHaveLength(0);
  });

  it("falls back to selecting the command and execCommand without the async Clipboard API", async () => {
    const exec = vi.fn(() => true);
    setExecCommand(exec);
    setup(null);
    press("Hard ceiling", "ArrowLeft");
    await settle();
    const row = within(rowOf("Hard ceiling"));
    fireEvent.click(row.getByRole("button", { name: "Copy command" }));
    await flush();
    expect(exec).toHaveBeenCalledWith("copy");
    expect(window.getSelection()?.toString()).toBe("volleyd config set hard_ceiling 11");
    expect(row.getByRole("button", { name: "Copy command" })).toHaveTextContent("Copied");
  });

  it("asks the user to copy by hand when the clipboard rejects and execCommand fails", async () => {
    setClipboard({ writeText: vi.fn(async () => Promise.reject(new Error("denied"))) });
    setExecCommand(() => false);
    setup(null);
    press("Hard ceiling", "ArrowLeft");
    await settle();
    const row = within(rowOf("Hard ceiling"));
    fireEvent.click(row.getByRole("button", { name: "Copy command" }));
    await flush();
    expect(row.getByRole("button", { name: "Copy command" })).toHaveTextContent("Select and copy");
    expect(window.getSelection()?.toString()).toBe("volleyd config set hard_ceiling 11");
  });

  it("Escape in a text field drops its edit and keeps the Settings window open", async () => {
    const f = fakeClient();
    const onClose = vi.fn();
    render(
      <SettingsWindow
        initial="supervisor"
        look={LOOK0}
        setLook={() => {}}
        notify={{ enabled: false, sound: true, on: [] }}
        setNotify={() => {}}
        webgl
        identity="desk"
        demo={false}
        config={config}
        transport={createConfigTransport(f.client, { identity: "desk" })}
        onArrange={() => {}}
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Recovery" }));
    const box = screen.getByRole("textbox", { name: "Fallback model" });
    fireEvent.change(box, { target: { value: "other-model" } });
    fireEvent.keyDown(box, { key: "Escape" });
    fireEvent.blur(box);
    await flush();
    expect(onClose).not.toHaveBeenCalled();
    // Nor does it go back from the group's page.
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("Recovery");
    expect(box).toHaveValue("claude-sonnet-5-5");
    expect(f.published).toHaveLength(0);
  });
});

describe("SettingsModal (a wave's settings)", () => {
  const renderModal = (w = wave(), onClose = vi.fn(), onOpenGlobal = vi.fn()) => {
    render(<SettingsModal wave={w} onClose={onClose} onOpenGlobal={onOpenGlobal} />);
    return { onClose, onOpenGlobal };
  };

  it("shows the wave's effective config, read-only, with no scope switch", () => {
    renderModal();
    expect(screen.queryByRole("radio")).toBeNull();
    expect(slider("Hard ceiling")).toHaveAttribute("aria-valuenow", "4");
    expect(slider("Hard ceiling")).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("textbox", { name: "Fallback model" })).toBeDisabled();
    expect(screen.getByText(/wave file's/)).toHaveTextContent("config:");
    expect(screen.queryByText(/Pick a new value/)).not.toBeInTheDocument();
  });

  it("has no account row: the wave's account is its window's chip", () => {
    const w = wave();
    renderModal({ ...w, account: { pinned: "team", source: "wave" } });
    expect(screen.queryByText("Claude account")).toBeNull();
    expect(screen.queryByRole("combobox", { name: /Move wave/ })).toBeNull();
    expect(document.querySelector(".modal-acct")).toBeNull();
  });

  it("shows only a note while the wave has no effective config", () => {
    const { state, ...rest } = wave();
    const { effective_config: _, ...bare } = state as NonNullable<WaveView["state"]>;
    renderModal({ ...rest, state: bare });
    expect(screen.getByText("No effective config for this wave yet.")).toBeInTheDocument();
    expect(screen.queryAllByRole("slider")).toHaveLength(0);
  });

  it("links to the global config", () => {
    const { onOpenGlobal } = renderModal();
    fireEvent.click(screen.getByRole("button", { name: "Global settings…" }));
    expect(onOpenGlobal).toHaveBeenCalledTimes(1);
  });

  it("closes on Done, Escape, the close button and a scrim click", () => {
    const { onClose } = renderModal();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    fireEvent.click(screen.getByRole("button", { name: "Close settings" }));
    fireEvent.pointerDown(screen.getByRole("dialog").parentElement as HTMLElement);
    expect(onClose).toHaveBeenCalledTimes(3);
    // Focus moves into the dialog on open, so Escape works without a click first.
    expect(screen.getByRole("dialog")).toHaveFocus();
    fireEvent.keyDown(document.activeElement as Element, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(4);
  });
});

describe("createConfigTransport", () => {
  it("carries the wave and the sender identity, with the namespace in the topic only", async () => {
    const f = fakeClient();
    const t = createConfigTransport(f.client, { identity: "desk", namespace: "dispatch" });
    const sent = t.send({ hard_ceiling: 3 }, { wave: "status-chip", text: "hard ceiling" });
    await flush();
    const { topic, envelope } = f.published[0] as (typeof f.published)[number];
    expect(topic).toBe("volley/dispatch/volleyd/mailbox");
    expect(envelope).not.toHaveProperty("namespace");
    expect(envelope).toMatchObject({
      payload: {
        op: "config_set",
        text: "hard ceiling",
        patch: { hard_ceiling: 3 },
        by: "desk",
        wave: "status-chip",
      },
    });
    // The answer arrives on the Desk's own mailbox in that namespace.
    await f.deliver("volley/dispatch/desk/mailbox", {
      schema_version: "0.1",
      agent_id: "volleyd",
      channel: "mailbox",
      type: "ack",
      wall_time: "2026-10-18T12:00:01.000Z",
      correlation_id: envelope.correlation_id as string,
      payload: { text: "ok", ok: true, applied: true, rejected: [], result: { version: 9 } },
    });
    await expect(sent).resolves.toEqual({ applied: true, version: 9, rejected: [] });
    expect(f.handlers.size).toBe(0);
  });

  it("accepts the answer only from volleyd (SPEC §4.4 MUST, P2-9)", async () => {
    const f = fakeClient();
    const t = createConfigTransport(f.client, { identity: "desk" });
    let settled = false;
    const sent = t.send({ hard_ceiling: 3 }).then((a) => {
      settled = true;
      return a;
    });
    await flush();
    const id = f.published[0]?.envelope.correlation_id as string;
    const answer = (agent_id: string, version: number): Envelope => ({
      schema_version: "0.1",
      agent_id,
      channel: "mailbox",
      type: "ack",
      wall_time: "2026-10-18T12:00:01.000Z",
      correlation_id: id,
      payload: { ok: true, applied: true, rejected: [], result: { version } },
    });
    // Anyone may write the Desk's mailbox; a forged answer must not settle the request.
    await f.deliver("volley/default/desk/mailbox", answer("impl-a1", 99));
    expect(settled).toBe(false);
    await f.deliver("volley/default/desk/mailbox", answer("volleyd", 9));
    await expect(sent).resolves.toEqual({ applied: true, version: 9, rejected: [] });
  });

  it("reports a daemon error and an unanswered request", async () => {
    vi.useFakeTimers();
    try {
      const f = fakeClient();
      const t = createConfigTransport(f.client, { identity: "desk", timeoutMs: 1000 });
      const unanswered = t.send({ hard_ceiling: 3 });
      await vi.advanceTimersByTimeAsync(1000);
      await expect(unanswered).resolves.toEqual({
        applied: false,
        rejected: [],
        error: "volleyd did not answer within 1s",
        unanswered: true,
      });
      expect(f.handlers.size).toBe(0);

      const failing: ConfigClient = {
        ...f.client,
        publish: async () => {
          throw new Error("not authorised");
        },
      };
      await expect(
        createConfigTransport(failing, { identity: "desk" }).send({ hard_ceiling: 3 }),
      ).resolves.toEqual({ applied: false, rejected: [], error: "not authorised" });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("copyCommand", () => {
  it("prints values the way volleyd config set parses them (YAML)", () => {
    expect(copyCommand("hard_ceiling", 12)).toBe("volleyd config set hard_ceiling 12");
    expect(copyCommand("fallback_model", null)).toBe("volleyd config set fallback_model null");
    expect(copyCommand("fallback_model", "claude-sonnet-5-5")).toBe(
      "volleyd config set fallback_model claude-sonnet-5-5",
    );
    expect(copyCommand("worktree_root", "/tmp/volley worktrees")).toBe(
      `volleyd config set worktree_root '"/tmp/volley worktrees"'`,
    );
    expect(copyCommand("fallback_model", "null")).toBe(
      `volleyd config set fallback_model '"null"'`,
    );
    expect(copyCommand("worktree_root", "it's")).toBe(
      `volleyd config set worktree_root '"it'\\''s"'`,
    );
  });
});

describe("App wiring", () => {
  it("the wave window's gear opens the settings for that wave; Supervisor is read-only without credentials", () => {
    render(
      <DeskStoreProvider demo>
        <App />
      </DeskStoreProvider>,
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Settings for ci-speed" }));
    expect(screen.getByRole("dialog", { name: "Wave settings" })).toHaveTextContent("ci-speed");
    fireEvent.click(screen.getByRole("button", { name: "Global settings…" }));
    fireEvent.click(screen.getByRole("button", { name: "Admission" }));
    expect(screen.getByText(/read-only/i)).toBeInTheDocument();
    expect(within(rowOf("Hard ceiling")).getByText(/Pick a new value/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close settings" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("gives focus back to the gear when the modal closes", () => {
    render(
      <DeskStoreProvider demo>
        <App />
      </DeskStoreProvider>,
    );
    const gear = screen.getByRole("button", { name: "Settings for ci-speed" });
    gear.focus();
    fireEvent.click(gear);
    expect(screen.getByRole("dialog")).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(gear).toHaveFocus();
  });

  it("signed in, Settings › Supervisor writes config_set to volleyd's mailbox in its namespace (P1-3)", async () => {
    const handlers = new Set<(m: DeskMessage) => void>();
    const connected = new Set<() => void>();
    const published: { topic: string; envelope: Envelope }[] = [];
    const client: DeskMqttClient = {
      connect: async () => {
        for (const h of connected) h();
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
        connected.add(h);
        return () => connected.delete(h);
      },
      onDisconnect: () => () => {},
      onError: () => () => {},
    };
    const deliver = (topic: string, envelope: Envelope) =>
      act(async () => {
        for (const h of handlers) h({ topic, envelope, receivedAt: Date.now() });
      });
    render(
      <DeskStoreProvider
        demo={false}
        brokerUrl="ws://test.invalid"
        auth={{ username: "desk", password: "pw" }}
        clientFactory={() => client}
      >
        <App />
      </DeskStoreProvider>,
    );
    await deliver("volley/_system/registry/volleyd", {
      schema_version: "0.1",
      agent_id: "volleyd",
      parent_id: null,
      namespace: "ops",
      channel: "_system/registry",
      type: "registered",
      wall_time: "2026-10-18T12:00:00.000Z",
      payload: { capabilities: ["supervises-waves"], started_at: "2026-10-18T12:00:00.000Z" },
    });
    await deliver("volley/_waves/_config", {
      schema_version: "0.1",
      agent_id: "volleyd",
      channel: "_waves/config",
      type: "config",
      wall_time: "2026-10-18T12:00:00.000Z",
      payload: config,
    });
    await deliver("volley/_waves/status-chip/state", {
      schema_version: "0.1",
      agent_id: "volleyd",
      channel: "_waves/state",
      type: "wave_state",
      wall_time: "2026-10-18T12:00:00.000Z",
      payload: wave().state,
    });
    // The retained replay has reached the Desk once the wave window is up.
    await screen.findByRole("button", { name: "Settings for status-chip" });
    fireEvent.click(
      within(screen.getByRole("toolbar", { name: "Dock" })).getByRole("button", {
        name: "Settings",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Supervisor" }));
    fireEvent.click(screen.getByRole("button", { name: "Admission" }));
    expect(screen.queryByText(/read-only/i)).not.toBeInTheDocument();
    expect(slider("Hard ceiling")).not.toHaveAttribute("aria-disabled", "true");
    fireEvent.click(screen.getByRole("button", { name: "Back to Supervisor" }));
    fireEvent.click(screen.getByRole("button", { name: "Recovery" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Fallback model" }), {
      target: { value: "claude-haiku-5-5" },
    });
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Fallback model" }), { key: "Enter" });
    await flush();
    const req = published.find((p) => p.topic === "volley/ops/volleyd/mailbox");
    expect(req?.envelope).toMatchObject({
      agent_id: "desk",
      type: "query",
      payload: { op: "config_set", patch: { fallback_model: "claude-haiku-5-5" }, by: "desk" },
    });
    // volleyd answers on the Desk's own mailbox in that namespace.
    await deliver("volley/ops/desk/mailbox", {
      schema_version: "0.1",
      agent_id: "volleyd",
      channel: "mailbox",
      type: "ack",
      wall_time: "2026-10-18T12:00:01.000Z",
      correlation_id: req?.envelope.correlation_id as string,
      payload: { ok: true, applied: true, rejected: [], result: { version: 8 } },
    });
    expect(await screen.findByText("applied · v8")).toBeInTheDocument();
  });

  it("does not reopen the modal by itself when its wave goes away and comes back", async () => {
    const handlers = new Set<(m: DeskMessage) => void>();
    const none = () => () => {};
    const client: DeskMqttClient = {
      connect: async () => {},
      disconnect: async () => {},
      publish: async () => {},
      onMessage: (h) => {
        handlers.add(h);
        return () => handlers.delete(h);
      },
      onConnect: none,
      onDisconnect: none,
      onError: none,
    };
    const state = wave().state;
    const retained = (envelope: Envelope | null) =>
      act(async () => {
        for (const h of handlers) {
          h({ topic: "volley/_waves/status-chip/state", envelope, receivedAt: Date.now() });
        }
      });
    const waveEnvelope: Envelope = {
      schema_version: "0.1",
      agent_id: "volleyd",
      channel: "_waves/state",
      type: "wave_state",
      wall_time: "2026-10-18T12:00:00.000Z",
      payload: state,
    };
    render(
      <DeskStoreProvider demo={false} brokerUrl="ws://test.invalid" clientFactory={() => client}>
        <App />
      </DeskStoreProvider>,
    );
    await retained(waveEnvelope);
    fireEvent.click(await screen.findByRole("button", { name: "Settings for status-chip" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await retained(null);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await retained(waveEnvelope);
    expect(
      await screen.findByRole("button", { name: "Settings for status-chip" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
