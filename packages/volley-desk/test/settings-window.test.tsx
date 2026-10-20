import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import pkg from "../package.json";
import App from "../src/App";
import { LOOK_STORAGE_KEY, type Look, useLook } from "../src/look/useLook";
import {
  NOTIFY_STORAGE_KEY,
  type NotifyOptions,
  useNotifySettings,
} from "../src/notify/use-notify-settings";
import { SettingsWindow, type SettingsWindowProps } from "../src/settings/SettingsWindow";
import { type ConfigClient, createConfigTransport } from "../src/settings/configTransport";
import { SETTINGS_SECTIONS, type SectionKey } from "../src/settings/sections";
import { DeskStoreProvider } from "../src/store/context";
import type { ConfigPayload, DeskMessage, Envelope } from "../src/store/types";

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

const settingsCss = readFileSync(join(__dirname, "../src/styles/settings.css"), "utf8").replace(
  /\s+/g,
  " ",
);

/** A Notification API whose permission prompt stays open until the returned function answers it. */
function pendingPermission(): (result: NotificationPermission) => void {
  let answer: (result: NotificationPermission) => void = () => {};
  const ctor = vi.fn() as unknown as typeof Notification;
  Object.defineProperty(ctor, "permission", { value: "default", configurable: true });
  Object.defineProperty(ctor, "requestPermission", {
    value: () =>
      new Promise<NotificationPermission>((resolve) => {
        answer = resolve;
      }),
    configurable: true,
  });
  Object.defineProperty(globalThis, "Notification", {
    configurable: true,
    writable: true,
    value: ctor,
  });
  return (result) => answer(result);
}

afterEach(() => {
  (globalThis as { Notification?: unknown }).Notification = undefined;
});

let latestLook: Look;
let latestNotify: NotifyOptions;
type HarnessProps = Partial<Omit<SettingsWindowProps, "look" | "setLook" | "notify" | "setNotify">>;
function Harness(p: HarnessProps) {
  const [look, setLook] = useLook();
  const [notify, setNotify] = useNotifySettings();
  latestLook = look;
  latestNotify = notify;
  return (
    <SettingsWindow
      look={look}
      setLook={setLook}
      notify={notify}
      setNotify={setNotify}
      webgl
      identity="desk"
      demo={false}
      config={config}
      transport={null}
      onArrange={() => {}}
      onClose={() => {}}
      {...p}
    />
  );
}

const stored = () => JSON.parse(localStorage.getItem(LOOK_STORAGE_KEY) ?? "{}");
const dialog = () => screen.getByRole("dialog", { name: "Settings" });
const sidebar = () => within(screen.getByRole("navigation", { name: "Settings sections" }));
const open = (label: string) => fireEvent.click(sidebar().getByRole("button", { name: label }));
const heading = () => within(dialog()).getByRole("heading", { level: 2 });

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem(LOOK_STORAGE_KEY, JSON.stringify({ bg: "none", autoArrange: false }));
});

describe("SettingsWindow", () => {
  it("lists eight sections in three groups, General first", () => {
    render(<Harness />);
    const lists = sidebar().getAllByRole("list");
    expect(lists).toHaveLength(3);
    expect(
      lists.map((l) =>
        within(l)
          .getAllByRole("button")
          .map((b) => b.textContent),
      ),
    ).toEqual([
      ["General", "Appearance"],
      ["Supervisor", "Claude accounts & usage", "Broker accounts", "Machines"],
      ["Setup & Security", "About Volley"],
    ]);
    expect(SETTINGS_SECTIONS).toHaveLength(8);
    expect(heading()).toHaveTextContent("General");
    expect(sidebar().getByRole("button", { name: "General" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("opens on the section it is given and switches sections from the sidebar", () => {
    render(<Harness initial="supervisor" />);
    expect(heading()).toHaveTextContent("Supervisor");
    open("About Volley");
    expect(heading()).toHaveTextContent("About Volley");
    expect(sidebar().getByRole("button", { name: "About Volley" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("closes on Escape, the close button and a scrim click", () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    // Focus moves into the window so Escape works at once.
    expect(dialog().contains(document.activeElement)).toBe(true);
    const notCancelled = fireEvent.keyDown(document.activeElement as HTMLElement, {
      key: "Escape",
    });
    // Claimed, so the Desk's window-level Escape doesn't close the next dialog down too.
    expect(notCancelled).toBe(false);
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Close settings" }));
    expect(onClose).toHaveBeenCalledTimes(2);
    fireEvent.pointerDown(dialog().parentElement as HTMLElement);
    expect(onClose).toHaveBeenCalledTimes(3);
    // A press inside the window is not a scrim click.
    fireEvent.pointerDown(dialog());
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it("the account row shows the signed-in broker username and its role", () => {
    const { rerender } = render(<Harness identity="desk" />);
    const account = () => within(screen.getByRole("group", { name: "Signed-in account" }));
    expect(account().getByText("desk")).toBeInTheDocument();
    expect(account().getByText(/Desk · can steer and change settings/)).toBeInTheDocument();
    // At phone width only the avatar shows: its title carries the name and the role.
    expect(
      screen.getByRole("group", { name: "Signed-in account" }).querySelector(".avatar"),
    ).toHaveAttribute("title", expect.stringMatching(/^desk · Desk · can steer/));
    rerender(<Harness identity="implementer-k3p9" />);
    expect(account().getByText("implementer-k3p9")).toBeInTheDocument();
    expect(account().getByText(/Agent identity/)).toBeInTheDocument();
    rerender(<Harness identity={null} />);
    expect(account().getByText("Not signed in")).toBeInTheDocument();
    expect(account().getByText(/Read-only/)).toBeInTheDocument();
    rerender(<Harness identity="desk" demo />);
    expect(account().getByText(/Demo · no broker/)).toBeInTheDocument();
  });

  describe("General", () => {
    it("auto-arrange, show finished agents and narration write the look", () => {
      const onArrange = vi.fn();
      render(<Harness onArrange={onArrange} />);
      const auto = screen.getByRole("switch", { name: "Auto-arrange" });
      expect(auto).toHaveAttribute("aria-checked", "false");
      fireEvent.click(auto);
      expect(latestLook.autoArrange).toBe(true);
      expect(stored().autoArrange).toBe(true);
      expect(auto).toHaveAttribute("aria-checked", "true");
      fireEvent.click(screen.getByRole("button", { name: "Arrange & fit now" }));
      expect(onArrange).toHaveBeenCalledTimes(1);

      const finished = screen.getByRole("switch", { name: "Show finished agents" });
      fireEvent.click(finished);
      expect(latestLook.showFinished).toBe(true);
      expect(stored().showFinished).toBe(true);

      const narr = within(screen.getByRole("radiogroup", { name: "Narration effect" }));
      fireEvent.click(narr.getByRole("radio", { name: "Shiny" }));
      expect(latestLook.narr).toBe("shiny");
      expect(stored().narr).toBe("shiny");
    });

    it("sets how long finished agents stay on the canvas, committing on blur or Enter", () => {
      render(<Harness />);
      const grace = screen.getByRole("spinbutton", { name: /Hide finished agents after/ });
      expect(grace).toHaveValue(10);
      // Typing is a draft: backspacing 10 → 1 → "" → 45 hides nothing on the way.
      fireEvent.change(grace, { target: { value: "1" } });
      fireEvent.change(grace, { target: { value: "" } });
      expect(latestLook.finishedGraceMin).toBe(10);
      fireEvent.change(grace, { target: { value: "45" } });
      fireEvent.blur(grace);
      expect(latestLook.finishedGraceMin).toBe(45);
      expect(stored().finishedGraceMin).toBe(45);
      fireEvent.change(grace, { target: { value: "30" } });
      fireEvent.keyDown(grace, { key: "Enter" });
      expect(latestLook.finishedGraceMin).toBe(30);
      // An invalid draft is dropped and the field shows the saved value again.
      fireEvent.change(grace, { target: { value: "-3" } });
      fireEvent.blur(grace);
      expect(latestLook.finishedGraceMin).toBe(30);
      expect(grace).toHaveValue(30);
    });

    it("sound writes the notify settings and the browser notifications row shows their state", async () => {
      render(<Harness />);
      const sound = screen.getByRole("switch", { name: "Sound when something needs you" });
      expect(sound).toHaveAttribute("aria-checked", "true");
      fireEvent.click(sound);
      expect(latestNotify.sound).toBe(false);
      const notifications = screen.getByRole("switch", { name: "Browser notifications" });
      expect(notifications).toHaveAttribute("aria-checked", "false");
      // jsdom has no Notification API: asking resolves to denied, and the row says so.
      fireEvent.click(notifications);
      expect(await screen.findByText(/Blocked in this browser/)).toBeInTheDocument();
      expect(latestNotify.enabled).toBe(false);
    });

    it("a sound change while the permission prompt is open survives its answer", async () => {
      const answer = pendingPermission();
      render(<Harness />);
      fireEvent.click(screen.getByRole("switch", { name: "Browser notifications" }));
      fireEvent.click(screen.getByRole("switch", { name: "Sound when something needs you" }));
      expect(latestNotify.sound).toBe(false);
      await act(async () => answer("granted"));
      expect(latestNotify).toMatchObject({ enabled: true, sound: false });
      expect(JSON.parse(localStorage.getItem(NOTIFY_STORAGE_KEY) ?? "{}")).toMatchObject({
        enabled: true,
        sound: false,
      });
    });
  });

  describe("Appearance", () => {
    it("search filters the backgrounds and keeps the current one listed", () => {
      render(<Harness initial="appearance" />);
      const grid = () => within(screen.getByRole("group", { name: "Backgrounds" }));
      fireEvent.change(screen.getByRole("searchbox", { name: "Search backgrounds" }), {
        target: { value: "light" },
      });
      expect(
        grid()
          .getAllByRole("button")
          .map((b) => b.textContent),
      ).toEqual([
        "Lightfall",
        "Lightning",
        "Light Pillar",
        "Light Rays",
        "Light Tunnel",
        "None (plain)", // current
      ]);
      expect(screen.getByRole("group", { name: "Backgrounds" })).toHaveClass("bg-grid--3");
      fireEvent.click(grid().getByRole("button", { name: "Light Rays" }));
      expect(latestLook.bg).toBe("LightRays");
      expect(stored().bg).toBe("LightRays");
    });

    it("dim, window style, Needs-you effect and tethers write the look", () => {
      render(<Harness initial="appearance" />);
      fireEvent.change(screen.getByRole("slider", { name: "Dim background" }), {
        target: { value: "0.6" },
      });
      expect(latestLook.dim).toBe(0.6);
      expect(screen.getByText("60%")).toBeInTheDocument();
      const seg = (group: string, name: string) =>
        within(screen.getByRole("radiogroup", { name: group })).getByRole("radio", { name });
      fireEvent.click(seg("Window style", "Solid"));
      expect(latestLook.chrome).toBe("solid");
      fireEvent.click(seg("Needs you effect", "Star border"));
      expect(latestLook.attn).toBe("star");
      const tethers = screen.getByRole("switch", { name: "Tethers" });
      expect(tethers).toHaveAttribute("aria-checked", "true");
      fireEvent.click(tethers);
      expect(stored()).toMatchObject({ dim: 0.6, chrome: "solid", attn: "star", tethers: false });
    });
  });

  describe("Supervisor", () => {
    it("renders the schema rows with the global values, read-only without credentials", () => {
      render(<Harness initial="supervisor" />);
      for (const h of ["Admission", "Leases", "Attention", "Recovery"]) {
        expect(screen.getByRole("heading", { name: h })).toBeInTheDocument();
      }
      expect(screen.getByRole("slider", { name: "Hard ceiling" })).toHaveAttribute(
        "aria-valuenow",
        "12",
      );
      expect(screen.getByText(/Read-only: the Desk has no broker credentials/)).toBeInTheDocument();
    });

    it("sends config_set through the transport and shows the ack", async () => {
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
      render(
        <Harness
          initial="supervisor"
          transport={createConfigTransport(client, { identity: "desk" })}
        />,
      );
      const box = screen.getByRole("textbox", { name: "Fallback model" });
      fireEvent.change(box, { target: { value: "claude-haiku-5-5" } });
      fireEvent.keyDown(box, { key: "Enter" });
      await act(async () => {});
      expect(published[0]?.topic).toBe("volley/default/volleyd/mailbox");
      expect(published[0]?.envelope.payload).toMatchObject({
        op: "config_set",
        patch: { fallback_model: "claude-haiku-5-5" },
      });
      await act(async () => {
        for (const h of handlers) {
          h({
            topic: "volley/default/desk/mailbox",
            receivedAt: Date.now(),
            envelope: {
              schema_version: "0.1",
              agent_id: "volleyd",
              channel: "mailbox",
              type: "ack",
              wall_time: "2026-10-18T12:00:01.000Z",
              correlation_id: published[0]?.envelope.correlation_id as string,
              payload: { ok: true, applied: true, rejected: [], result: { version: 8 } },
            },
          });
        }
      });
      expect(await screen.findByText("applied · v8")).toBeInTheDocument();
    });
  });

  it("is built like a Desk window (D10): lifted depth body and the lit edge", () => {
    render(<Harness />);
    expect(dialog()).toHaveClass("win-depth");
    expect(dialog().querySelector(":scope > .win-edge")).not.toBeNull();
    const rule = settingsCss.slice(settingsCss.indexOf(".mac-settings {"));
    expect(rule.slice(0, rule.indexOf("}"))).toMatch(/--win-body: linear-gradient/);
  });

  it("the pickers are Gooey Nav radiogroups: one Tab stop, arrow keys move and commit (D10)", () => {
    render(<Harness initial="appearance" />);
    const group = screen.getByRole("radiogroup", { name: "Window style" });
    expect(group.querySelector(".gooey-nav.gooey-seg")).not.toBeNull();
    const radio = (name: string) => within(group).getByRole("radio", { name });
    expect(radio("Frosted glass")).toHaveAttribute("aria-checked", "true");
    expect(radio("Frosted glass")).toHaveAttribute("tabindex", "0");
    expect(radio("Liquid glass")).toHaveAttribute("tabindex", "-1");
    radio("Frosted glass").focus();
    fireEvent.keyDown(radio("Frosted glass"), { key: "ArrowRight" });
    expect(latestLook.chrome).toBe("liquid");
    expect(radio("Liquid glass")).toHaveAttribute("aria-checked", "true");
    expect(radio("Liquid glass")).toHaveAttribute("tabindex", "0");
    expect(document.activeElement).toBe(radio("Liquid glass"));
    fireEvent.keyDown(radio("Liquid glass"), { key: "End" });
    expect(latestLook.chrome).toBe("solid");
    // Wraps, as the agent tabs do.
    fireEvent.keyDown(radio("Solid"), { key: "ArrowRight" });
    expect(latestLook.chrome).toBe("glass");
    fireEvent.keyDown(radio("Frosted glass"), { key: "ArrowUp" });
    expect(latestLook.chrome).toBe("solid");
  });

  it.each([
    ["the sidebar search", "general" as SectionKey, "Search settings"],
    ["the background search", "appearance" as SectionKey, "Search backgrounds"],
  ])("Escape in %s clears a query and keeps the window open", (_, initial, name) => {
    const onClose = vi.fn();
    render(<Harness initial={initial} onClose={onClose} />);
    const box = screen.getByRole("searchbox", { name });
    fireEvent.change(box, { target: { value: "zzz" } });
    fireEvent.keyDown(box, { key: "Escape" });
    expect(box).toHaveValue("");
    expect(onClose).not.toHaveBeenCalled();
    // An empty box: Escape closes the window as anywhere else.
    fireEvent.keyDown(box, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("About shows the package version, the licences and the React Bits credit", () => {
    render(<Harness initial="about" />);
    const body = within(dialog());
    expect(body.getByText(new RegExp(`Volley ${pkg.version.replace(/\./g, "\\.")}`))).toBeTruthy();
    expect(body.getByText(/Apache-2\.0/)).toBeInTheDocument();
    expect(body.getByText(/Backgrounds by React Bits/)).toBeInTheDocument();
  });

  it("Claude accounts & usage shows the accounts section, read-only without a control channel", () => {
    render(<Harness initial="claude" />);
    expect(heading()).toHaveTextContent("Claude accounts & usage");
    const body = within(dialog());
    expect(body.queryByText(/Coming with Onboarding/)).toBeNull();
    expect(body.getByRole("button", { name: "+ Add Claude account" })).toBeDisabled();
    expect(body.getByText("Warn me at")).toBeInTheDocument();
  });

  it("Machines shows this machine's card, read-only without the pairing ops", () => {
    render(<Harness initial="machines" />);
    expect(heading()).toHaveTextContent("Machines");
    const body = within(dialog());
    expect(body.queryByText(/Coming with Onboarding/)).toBeNull();
    expect(body.getByRole("article", { name: "This machine" })).toBeInTheDocument();
    expect(body.queryByRole("button", { name: "+ Add a machine" })).toBeNull();
    expect(body.getByText(/Read-only/)).toBeInTheDocument();
  });

  it("the account row shows an admin as admin while Machines is open, from the pairing ops' answer", async () => {
    // A password sign-in: no stored role. Machines asks its ops (once); the row follows that answer.
    let answer: (a: "admin") => void = () => {};
    const ops = {
      known: vi.fn(() => null),
      admin: vi.fn(
        () =>
          new Promise<"admin">((resolve) => {
            answer = resolve;
          }),
      ),
      invite: vi.fn(),
      remove: vi.fn(),
      doctor: vi.fn(),
    };
    render(
      <Harness
        initial="machines"
        identity="owner-admin"
        machines={{ machines: {}, hubUp: true, ops }}
      />,
    );
    const account = () => within(screen.getByRole("group", { name: "Signed-in account" }));
    expect(account().getByText(/Agent identity/)).toBeInTheDocument();
    await act(async () => answer("admin"));
    expect(account().getByText("Admin · manages accounts and setup")).toBeInTheDocument();
    expect(ops.admin).toHaveBeenCalledTimes(1);
  });

  it("Broker accounts and Setup & Security are read-only without an admin", () => {
    render(<Harness initial="accounts" />);
    expect(heading()).toHaveTextContent("Broker accounts");
    expect(within(dialog()).getByText(/Only an admin can list and manage/)).toBeInTheDocument();
    expect(within(dialog()).queryByText(/Coming with Onboarding/)).not.toBeInTheDocument();
    fireEvent.click(within(dialog()).getByRole("button", { name: "Setup & Security" }));
    expect(heading()).toHaveTextContent("Setup & Security");
    expect(within(dialog()).getByText("Connected to")).toBeInTheDocument();
    expect(within(dialog()).queryByRole("button", { name: "Open setup…" })).toBeNull();
  });
});

describe("App: the Settings window", () => {
  const renderApp = () =>
    render(
      <DeskStoreProvider demo>
        <App />
      </DeskStoreProvider>,
    );
  const dock = () => within(screen.getByRole("toolbar", { name: "Dock" }));

  it("opens from the dock, picks reach every window, and Escape closes it", () => {
    const { container } = renderApp();
    expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull();
    fireEvent.click(dock().getByRole("button", { name: "Settings" }));
    expect(heading()).toHaveTextContent("General");
    // Demo mode signs in as the demo identity.
    expect(
      within(screen.getByRole("group", { name: "Signed-in account" })).getByText("desk"),
    ).toBeInTheDocument();
    open("Appearance");
    fireEvent.click(
      within(screen.getByRole("radiogroup", { name: "Window style" })).getByRole("radio", {
        name: "Solid",
      }),
    );
    const inners = [...container.querySelectorAll(".world .win-inner")];
    expect(inners.length).toBeGreaterThan(0);
    for (const el of inners) expect(el).toHaveClass("chrome-solid");
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull();
  });

  it("the top bar's notification toggle keeps a sound change made while the prompt is open", async () => {
    const answer = pendingPermission();
    renderApp();
    const bar = within(document.querySelector(".topbar") as HTMLElement);
    fireEvent.click(bar.getByRole("button", { name: "Browser notifications" }));
    fireEvent.click(bar.getByRole("button", { name: "Sound" }));
    await act(async () => answer("granted"));
    expect(bar.getByRole("button", { name: "Sound" })).toHaveAttribute("aria-pressed", "false");
    expect(JSON.parse(localStorage.getItem(NOTIFY_STORAGE_KEY) ?? "{}")).toMatchObject({
      enabled: true,
      sound: false,
    });
    // One "blocked" answer for both toggles: the top bar's and General's agree.
    fireEvent.click(bar.getByRole("button", { name: "Browser notifications" }));
    expect(bar.getByRole("button", { name: "Browser notifications" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("gives focus back to the dock's Settings item when it closes", () => {
    renderApp();
    const item = dock().getByRole("button", { name: "Settings" });
    item.focus();
    fireEvent.click(item);
    expect(dialog().contains(document.activeElement)).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Close settings" }));
    expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull();
    expect(item).toHaveFocus();
  });

  it("f, + and - leave the canvas alone while the Settings window is open", () => {
    const { container } = renderApp();
    const view = () => (container.querySelector(".world") as HTMLElement).style.transform;
    const v0 = view();
    fireEvent.click(dock().getByRole("button", { name: "Settings" }));
    const sw = within(dialog()).getByRole("switch", { name: "Auto-arrange" });
    sw.focus();
    for (const key of ["f", "+", "=", "-"]) {
      fireEvent.keyDown(sw, { key });
      fireEvent.keyDown(dialog(), { key });
    }
    expect(view()).toBe(v0);
    expect(container.querySelector(".world--anim")).toBeNull();
  });

  it("a wave's settings link to the Supervisor section for the global config", () => {
    renderApp();
    fireEvent.click(screen.getByRole("button", { name: "Settings for ci-speed" }));
    const wave = within(screen.getByRole("dialog", { name: "Wave settings" }));
    expect(wave.queryByRole("radio", { name: "Global" })).toBeNull();
    fireEvent.click(wave.getByRole("button", { name: "Global settings…" }));
    expect(screen.queryByRole("dialog", { name: "Wave settings" })).toBeNull();
    expect(heading()).toHaveTextContent("Supervisor");
  });
});
