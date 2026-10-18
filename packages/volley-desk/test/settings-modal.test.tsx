import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import App from "../src/App";
import { SettingsModal } from "../src/settings/SettingsModal";
import {
  type ConfigClient,
  type ConfigTransport,
  copyCommand,
  createConfigTransport,
} from "../src/settings/configTransport";
import { DeskStoreProvider } from "../src/store/context";
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

function setup(transport: ConfigTransport | null, onClose = vi.fn()) {
  render(<SettingsModal wave={wave()} config={config} transport={transport} onClose={onClose} />);
  return { onClose };
}

const slider = (name: string) => screen.getByRole("slider", { name });
const rowOf = (name: string) => slider(name).closest(".cfg-row") as HTMLElement;
const flush = () => act(async () => {});

describe("SettingsModal", () => {
  it("builds its sections from the schema and shows the current global values", () => {
    setup(null);
    fireEvent.click(screen.getByRole("radio", { name: "Global" }));
    for (const h of ["Admission", "Leases", "Attention", "Recovery"]) {
      expect(screen.getByRole("heading", { name: h })).toBeInTheDocument();
    }
    expect(slider("Hard ceiling")).toHaveAttribute("aria-valuenow", "12");
    expect(slider("Hard ceiling")).toHaveAttribute("aria-valuemax", "100");
    expect(slider("build pool capacity")).toHaveAttribute("aria-valuenow", "2");
    expect(screen.getByRole("textbox", { name: "Fallback model" })).toHaveValue(
      "claude-sonnet-5-5",
    );
    expect(
      screen.getByText(
        "Runaway fuse: maximum concurrently live supervised agents across all waves.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(/applies at the next admission tick/)).toHaveTextContent(
      "Saved through volleyd config set · applies at the next admission tick · never preempts running work",
    );
  });

  it("moving the hard-ceiling slider sends config_set to the daemon's mailbox and shows the ack", async () => {
    const f = fakeClient();
    setup(createConfigTransport(f.client, { identity: "desk" }));
    fireEvent.click(screen.getByRole("radio", { name: "Global" }));
    fireEvent.keyDown(slider("Hard ceiling"), { key: "ArrowRight" });
    await flush();

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
    setup(createConfigTransport(f.client, { identity: "desk" }));
    fireEvent.click(screen.getByRole("radio", { name: "Global" }));
    fireEvent.keyDown(slider("build pool capacity"), { key: "ArrowLeft" });
    await flush();
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

  it("shows the answer to the latest change of a row, not an older one that answers late", async () => {
    const f = fakeClient();
    setup(createConfigTransport(f.client, { identity: "desk" }));
    fireEvent.click(screen.getByRole("radio", { name: "Global" }));
    fireEvent.keyDown(slider("Hard ceiling"), { key: "ArrowRight" });
    fireEvent.keyDown(slider("Hard ceiling"), { key: "ArrowRight" });
    await flush();
    const [first, second] = f.published.map((p) => p.envelope.correlation_id as string);
    expect(f.published[1]?.envelope.payload).toMatchObject({ patch: { hard_ceiling: 14 } });
    await f.ack(second as string, {
      ok: true,
      applied: true,
      rejected: [],
      result: { version: 9 },
    });
    await f.ack(first as string, {
      ok: false,
      applied: false,
      rejected: [{ path: "hard_ceiling", reason: "superseded" }],
    });
    expect(within(rowOf("Hard ceiling")).getByText("applied · v9")).toBeInTheDocument();
    expect(slider("Hard ceiling")).toHaveAttribute("aria-valuenow", "14");
  });

  it("sends a text tunable on Enter, empty meaning null when the schema allows it", async () => {
    const f = fakeClient();
    setup(createConfigTransport(f.client, { identity: "desk" }));
    fireEvent.click(screen.getByRole("radio", { name: "Global" }));
    const box = screen.getByRole("textbox", { name: "Fallback model" });
    fireEvent.change(box, { target: { value: "" } });
    fireEvent.keyDown(box, { key: "Enter" });
    await flush();
    expect(f.published[0]?.envelope.payload).toMatchObject({ patch: { fallback_model: null } });
  });

  it("without credentials the control is disabled and the copy command is exact", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    setup(null);
    fireEvent.click(screen.getByRole("radio", { name: "Global" }));
    expect(screen.getByText(/read-only/i)).toBeInTheDocument();

    const row = rowOf("Hard ceiling");
    expect(slider("Hard ceiling")).toHaveAttribute("aria-disabled", "true");
    fireEvent.keyDown(slider("Hard ceiling"), { key: "ArrowRight" });
    expect(slider("Hard ceiling")).toHaveAttribute("aria-valuenow", "12");
    expect(within(row).getByText("volleyd config set hard_ceiling 12")).toBeInTheDocument();
    fireEvent.click(within(row).getByRole("button", { name: "Copy command" }));
    await flush();
    expect(writeText).toHaveBeenCalledWith("volleyd config set hard_ceiling 12");
    expect(within(row).getByRole("button", { name: "Copy command" })).toHaveTextContent("Copied");

    expect(screen.getByRole("textbox", { name: "Worktree root" })).toBeDisabled();
    expect(
      within(rowOf("build pool capacity")).getByText(
        "volleyd config set lease_pools.build.capacity 2",
      ),
    ).toBeInTheDocument();
  });

  it("the wave scope shows the wave's effective config, read-only, and never writes", async () => {
    const f = fakeClient();
    setup(createConfigTransport(f.client, { identity: "desk" }));
    const waveScope = screen.getByRole("radio", { name: "This wave (status-chip)" });
    expect(waveScope).toHaveAttribute("aria-checked", "true");
    expect(slider("Hard ceiling")).toHaveAttribute("aria-valuenow", "4");
    expect(slider("Hard ceiling")).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByText(/wave file's/)).toHaveTextContent("config:");
    fireEvent.keyDown(slider("Hard ceiling"), { key: "ArrowRight" });
    await flush();
    expect(f.published).toHaveLength(0);
    expect(screen.queryByText(/^volleyd config set \w/)).not.toBeInTheDocument();
  });

  it("shows only a note while the wave has no effective config", () => {
    const { state, ...rest } = wave();
    const { effective_config: _, ...bare } = state as NonNullable<WaveView["state"]>;
    const w: WaveView = { ...rest, state: bare };
    render(<SettingsModal wave={w} config={config} transport={null} onClose={() => {}} />);
    expect(screen.getByText("No effective config for this wave yet.")).toBeInTheDocument();
    expect(screen.queryAllByRole("slider")).toHaveLength(0);
    fireEvent.click(screen.getByRole("radio", { name: "Global" }));
    expect(screen.getAllByRole("slider").length).toBeGreaterThan(0);
  });

  it("closes on Done, Escape, the close button and a scrim click", () => {
    const { onClose } = setup(null);
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    fireEvent.click(screen.getByRole("button", { name: "Close settings" }));
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    fireEvent.pointerDown(screen.getByRole("dialog").parentElement as HTMLElement);
    expect(onClose).toHaveBeenCalledTimes(4);
  });
});

describe("createConfigTransport", () => {
  it("carries the wave, a namespace and the sender identity in the request", async () => {
    const f = fakeClient();
    const t = createConfigTransport(f.client, { identity: "desk", namespace: "dispatch" });
    const sent = t.send({ hard_ceiling: 3 }, { wave: "status-chip", text: "hard ceiling" });
    await flush();
    const { topic, envelope } = f.published[0] as (typeof f.published)[number];
    expect(topic).toBe("volley/dispatch/volleyd/mailbox");
    expect(envelope).toMatchObject({
      namespace: "dispatch",
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
  it("the wave window's gear opens the settings for that wave, read-only without credentials", () => {
    render(
      <DeskStoreProvider demo>
        <App />
      </DeskStoreProvider>,
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Settings for ci-speed" }));
    expect(screen.getByRole("radio", { name: "This wave (ci-speed)" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: "Global" }));
    expect(screen.getByText(/read-only/i)).toBeInTheDocument();
    expect(slider("Hard ceiling")).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
