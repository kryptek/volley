import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LOOK0 } from "../src/look/useLook";
import { autopilotSummaries } from "../src/settings/Autopilot";
import { claudeSummaries } from "../src/settings/ClaudeAccounts";
import { SettingsWindow, type SettingsWindowProps } from "../src/settings/SettingsWindow";
import { soundSummaries } from "../src/settings/Sound";
import { Supervisor, supervisorSummaries } from "../src/settings/Supervisor";
import { sectionOfPath } from "../src/settings/schemaRows";
import { groupOf, matchGroups, matchSections, sectionDef } from "../src/settings/sections";
import { SOUND_EVENT_IDS } from "../src/sounds/events";
import { SOUND0 } from "../src/sounds/settings";
import type { ControlReply } from "../src/steer/transport";
import type { ConfigPayload, LeasePoolPayload } from "../src/store/types";
import { machineRecord, readiness } from "./helpers/desk-msgs";

const config: ConfigPayload = {
  version: 7,
  updated_at: "2026-10-18T12:00:00.000Z",
  updated_by: "volleyd-defaults",
  hard_ceiling: 12,
  spawn_budget_multiplier: 3,
  lease_pools: { build: { capacity: 2, ttl_s: 1800, match: ["npm run build"] } },
  claim_after_s: 1800,
  heartbeat_alarm_s: 600,
  fallback_model: "claude-sonnet-5-5",
  spawn_timeout_s: 180,
  autopilot: {
    enabled: true,
    owner_only: ["plan_change", "repo_untrusted", "model_switch", "release_go", "stage_go"],
    merge: "auto",
  },
};

const at = "2026-10-18T12:00:00.000Z";
const leases: Record<string, LeasePoolPayload> = {
  build: {
    pool: "build",
    capacity: 2,
    held: [{ lease_id: "l-1", holder: "impl-1", host: "hub", since: at, ttl_s: 1800 }],
    queue: [],
    reasons: [],
  },
  test: { pool: "test", capacity: 2, held: [], queue: [], reasons: [] },
};

const RULES = [
  {
    policy: "hooks_auth_failed/relaunch",
    kind: "hooks_auth_failed",
    condition: "a bad launch",
    answer: "relaunch",
    budget: "relaunch_max per <task>/<role>",
    max: 1,
    rationale: "a bad launch is cheaper to retry than to read",
  },
  {
    policy: "plan_change/owner",
    kind: "plan_change",
    condition: "always",
    answer: "(escalate)",
    budget: null,
    max: null,
    rationale: "the plan is the owner's",
  },
];

type HarnessProps = Partial<SettingsWindowProps>;
const Harness = (p: HarnessProps) => (
  <SettingsWindow
    look={LOOK0}
    setLook={() => {}}
    notify={{ enabled: false, sound: true, on: [] }}
    setNotify={() => {}}
    webgl
    identity="desk"
    demo={false}
    config={config}
    transport={null}
    leases={leases}
    onArrange={() => {}}
    onClose={() => {}}
    {...p}
  />
);

const dialog = () => screen.getByRole("dialog", { name: "Settings" });
const heading = () => within(dialog()).getByRole("heading", { level: 2 });
const sidebar = () => within(screen.getByRole("navigation", { name: "Settings sections" }));
const side = (label: string) => fireEvent.click(sidebar().getByRole("button", { name: label }));
const groups = (section: string) => screen.getByRole("list", { name: `${section} groups` });
const rowNames = (section: string) =>
  within(groups(section))
    .getAllByRole("button")
    .map((b) => b.querySelector(".gl-label")?.textContent);
const row = (name: string) => screen.getByRole("button", { name });

beforeEach(() => localStorage.clear());

describe("Settings sections drill into groups (#286)", () => {
  it("Supervisor opens on a list of its groups with live summaries", () => {
    render(<Harness initial="supervisor" />);
    expect(rowNames("Supervisor")).toEqual([
      "Lease pools",
      "Admission",
      "Attention",
      "Recovery",
      "Other",
    ]);
    expect(screen.queryByRole("heading", { name: "Admission" })).toBeNull();
    expect(row("Admission")).toHaveAccessibleDescription("ceiling 12 · budget 3×");
    expect(row("Lease pools")).toHaveAccessibleDescription("2 pools · 1/4 held");
    expect(heading()).toHaveTextContent("Supervisor");
  });

  it("a row opens its page with a back control; Back returns to the row", () => {
    render(<Harness initial="supervisor" />);
    fireEvent.click(row("Admission"));
    expect(heading()).toHaveTextContent("Admission");
    expect(screen.getByRole("button", { name: "Back to Supervisor" })).toBeInTheDocument();
    expect(screen.getByRole("slider", { name: "Hard ceiling" })).toHaveAttribute(
      "aria-valuenow",
      "12",
    );
    expect(document.activeElement).toBe(heading());
    expect(screen.queryByRole("list", { name: "Supervisor groups" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Back to Supervisor" }));
    expect(groups("Supervisor")).toBeInTheDocument();
    expect(heading()).toHaveTextContent("Supervisor");
    expect(document.activeElement).toBe(row("Admission"));
  });

  it("Escape goes back from a page first, closes from the list, and clears a search first", () => {
    const onClose = vi.fn();
    render(<Harness initial="supervisor" onClose={onClose} />);
    fireEvent.click(row("Admission"));
    fireEvent.keyDown(heading(), { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    expect(groups("Supervisor")).toBeInTheDocument();

    fireEvent.click(row("Attention"));
    const search = screen.getByRole("searchbox", { name: "Search settings" });
    fireEvent.change(search, { target: { value: "claim" } });
    fireEvent.keyDown(search, { key: "Escape" });
    expect(search).toHaveValue("");
    expect(heading()).toHaveTextContent("Attention");
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.keyDown(heading(), { key: "Escape" });
    fireEvent.keyDown(row("Attention"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("remembers the open group per section while the window is open, not after", () => {
    const { unmount } = render(<Harness initial="supervisor" />);
    fireEvent.click(row("Attention"));
    side("About Volley");
    expect(heading()).toHaveTextContent("About Volley");
    side("Supervisor");
    expect(heading()).toHaveTextContent("Attention");
    unmount();
    render(<Harness initial="supervisor" />);
    expect(groups("Supervisor")).toBeInTheDocument();
  });

  it("the summaries follow the props", () => {
    const { rerender } = render(<Harness initial="supervisor" />);
    rerender(<Harness initial="supervisor" config={{ ...config, hard_ceiling: 8 }} />);
    expect(row("Admission")).toHaveAccessibleDescription("ceiling 8 · budget 3×");
    rerender(<Harness initial="supervisor" leases={{}} />);
    expect(row("Lease pools")).toHaveAccessibleDescription("No pools");
  });

  it("the deep link to fleet.local_agents lands on Supervisor › Admission with the row focused", () => {
    const spy = vi.fn();
    Object.defineProperty(Element.prototype, "scrollIntoView", { value: spy, configurable: true });
    try {
      const hub = machineRecord({ name: "hub", kind: "supervisor", tunnel: "local" });
      render(
        <Harness
          initial="machines"
          config={{ ...config, fleet: { local_name: "hub", local_agents: "fallback" } }}
          machines={{
            machines: { hub },
            readiness: {
              hub: readiness({ name: "hub", local_agents: { mode: "fallback", active: false } }),
            },
            localName: "hub",
            hubUp: true,
            ops: null,
          }}
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: "Local agents: fallback" }));
      expect(heading()).toHaveTextContent("Admission");
      expect(screen.getByRole("combobox", { name: "Fleet local agents" })).toHaveFocus();
    } finally {
      Reflect.deleteProperty(Element.prototype, "scrollIntoView");
    }
  });

  it("flat sections stay as they are", () => {
    render(<Harness initial="general" />);
    expect(screen.queryByRole("list", { name: "General groups" })).toBeNull();
    for (const h of ["Canvas", "Notifications", "Needs you", "Agent windows"]) {
      expect(screen.getByRole("heading", { name: h })).toBeInTheDocument();
    }
    side("Machines");
    expect(screen.queryByRole("list", { name: "Machines groups" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Back to/ })).toBeNull();
  });
});

describe("search reaches into groups", () => {
  it("matchGroups and groupOf name the group a query hits", () => {
    expect(matchGroups("rationale")).toEqual([{ section: "autopilot", group: "policy" }]);
    expect(matchSections("quiet hours").map((s) => s.key)).toContain("sound");
    expect(matchSections("")).toHaveLength(10);
    expect(groupOf(sectionDef("supervisor"), "ceiling")).toBe("admission");
    expect(groupOf(sectionDef("supervisor"), "")).toBeUndefined();
    expect(groupOf(sectionDef("supervisor"), "supervisor")).toBeUndefined();
    expect(groupOf(sectionDef("sound"), "quiet hours")).toBe("when");
  });

  it("sectionOfPath places a deep link's row", () => {
    expect(sectionOfPath("fleet.local_agents")).toBe("Admission");
    expect(sectionOfPath("claim_after_s")).toBe("Attention");
    expect(sectionOfPath("lease_pools.build.capacity")).toBe("Leases");
    expect(sectionOfPath("agent_auto_compact_pct")).toBe("Other");
  });

  it("a search hit opens its group, and Back highlights the row", () => {
    render(<Harness initial="general" />);
    fireEvent.change(screen.getByRole("searchbox", { name: "Search settings" }), {
      target: { value: "ceiling" },
    });
    side("Supervisor");
    expect(heading()).toHaveTextContent("Admission");
    fireEvent.click(screen.getByRole("button", { name: "Back to Supervisor" }));
    expect(row("Admission")).toHaveClass("gl-row--hit");
    expect(row("Attention")).not.toHaveClass("gl-row--hit");
  });
});

describe("the other grouped sections", () => {
  it("Autopilot: Tunables and the Policy table, its rule count once volleyd answers", async () => {
    const control = vi.fn(
      async (): Promise<ControlReply> => ({ ok: true, result: { rules: RULES } }),
    );
    render(
      <Harness initial="autopilot" claude={{ accounts: {}, signins: {}, waves: {}, control }} />,
    );
    expect(rowNames("Autopilot")).toEqual(["Tunables", "Policy table"]);
    expect(row("Tunables")).toHaveAccessibleDescription("on · 5 owner-only · merge auto");
    await act(async () => {});
    expect(row("Policy table")).toHaveAccessibleDescription("2 rules");
    fireEvent.click(row("Policy table"));
    expect(heading()).toHaveTextContent("Policy table");
    expect(screen.getByRole("table", { name: "Autopilot policy" })).toBeInTheDocument();
    expect(control).toHaveBeenCalledTimes(1);
  });

  it("Autopilot without broker credentials says so on the row", () => {
    render(<Harness initial="autopilot" />);
    expect(row("Policy table")).toHaveAccessibleDescription("needs broker credentials");
  });

  it("Sound: four groups; the Sounds page has the seven event cards", () => {
    render(<Harness initial="sound" />);
    expect(rowNames("Sound")).toEqual(["Theme", "Volume", "Sounds", "When sounds play"]);
    fireEvent.click(row("Sounds"));
    expect(
      within(dialog())
        .getAllByRole("heading", { level: 3 })
        .map((h) => h.textContent),
    ).toEqual(["UI", "Agents", "Pipeline", "Wave", "Steering", "System", "Attention"]);
  });

  it("Claude accounts: Accounts and Defaults; Defaults has the account for new waves", () => {
    render(<Harness initial="claude" />);
    expect(rowNames("Claude accounts & usage")).toEqual(["Accounts", "Defaults"]);
    fireEvent.click(row("Defaults"));
    expect(heading()).toHaveTextContent("Defaults");
    expect(
      screen.getByRole("button", { name: "Back to Claude accounts & usage" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Account for new waves")).toBeInTheDocument();
  });

  it("Defaults renders the account radiogroup when the Desk has broker credentials", () => {
    const send = vi.fn(async () => ({ applied: true, rejected: [] }));
    render(<Harness initial="claude" transport={{ identity: "desk", send }} />);
    fireEvent.click(row("Defaults"));
    expect(screen.getByRole("radiogroup", { name: "Account for new waves" })).toBeInTheDocument();
  });

  it("the Lease pools page does not repeat its title as a card heading", () => {
    render(<Harness initial="supervisor" />);
    fireEvent.click(row("Lease pools"));
    expect(heading()).toHaveTextContent("Lease pools");
    expect(within(dialog()).getAllByRole("heading", { name: "Lease pools" })).toHaveLength(1);
    expect(screen.getByRole("region", { name: "Lease pools" })).toBeInTheDocument();
  });
});

describe("summaries", () => {
  it("supervisorSummaries", () => {
    const s = supervisorSummaries({ config, leases });
    expect(s.leases).toBe("2 pools · 1/4 held");
    expect(s.admission).toBe("ceiling 12 · budget 3×");
    expect(s.attention).toBe("claim 30 min · heartbeat 10 min");
    expect(s.recovery).toBe("claude-sonnet-5-5 · spawn 3 min");
    expect(s.other).toMatch(/^\d+ settings?$/);
    expect(supervisorSummaries({ config: null, leases: {} }).leases).toBe("No pools");
  });

  it("autopilotSummaries", () => {
    const done = {
      state: "done" as const,
      rules: Array.from({ length: 12 }, () => RULES[0] as (typeof RULES)[number]),
    };
    expect(autopilotSummaries({ config, policy: done })).toEqual({
      tunables: "on · 5 owner-only · merge auto",
      policy: "12 rules",
    });
    const off = { ...config, autopilot: { enabled: false } };
    expect(autopilotSummaries({ config: off, policy: null })).toEqual({
      tunables: "off",
      policy: "needs broker credentials",
    });
    expect(autopilotSummaries({ config, policy: { state: "loading" } }).policy).toBe(
      "asking volleyd…",
    );
    expect(autopilotSummaries({ config, policy: { state: "failed", error: "x" } }).policy).toBe(
      "no table",
    );
  });

  it("soundSummaries", () => {
    const all = SOUND_EVENT_IDS.length;
    const s = soundSummaries({ sound: SOUND0, loading: false });
    expect(s.events).toBe(`${all - 1} of ${all} on`);
    expect(s.volume).toBe("70%");
    expect(s.when).toBe("always");
    expect(soundSummaries({ sound: { ...SOUND0, muted: true }, loading: false }).volume).toBe(
      "muted",
    );
    const quiet = { ...SOUND0, quietHours: { ...SOUND0.quietHours, on: true } };
    expect(soundSummaries({ sound: quiet, loading: false }).when).toBe("quiet 22:00–07:00");
    const both = { ...quiet, signalsOnlyWhenHidden: true };
    expect(soundSummaries({ sound: both, loading: false }).when).toBe(
      "only when hidden · quiet 22:00–07:00",
    );
    expect(soundSummaries({ sound: SOUND0, loading: true }).theme).toMatch(/ · loading…$/);
  });

  it("claudeSummaries", () => {
    expect(
      claudeSummaries({ accounts: 3, needsYou: 1, defaultLabel: "Most headroom", warnAt: 90 }),
    ).toEqual({ accounts: "3 accounts · 1 needs you", defaults: "Most headroom · warn at 90%" });
    expect(
      claudeSummaries({ accounts: 1, needsYou: 0, defaultLabel: "Primary", warnAt: 80 }).accounts,
    ).toBe("1 account");
  });
});

describe("the group list at phone width", () => {
  const css = readFileSync(join(__dirname, "../src/styles/settings.css"), "utf8").replace(
    /\s+/g,
    " ",
  );
  const phone = css.slice(css.indexOf("@media (max-width: 699.98px)"));
  const ruleFor = (block: string, selector: string) => {
    const i = block.indexOf(`${selector} {`);
    return i < 0 ? "" : block.slice(i, block.indexOf("}", i));
  };

  it("rows and the back control are 48px targets on a phone", () => {
    expect(ruleFor(phone, ".gl-row")).toContain("min-height: 48px");
    expect(ruleFor(phone, ".ms-back")).toContain("min-height: 48px");
  });

  it("the list is never width-capped", () => {
    expect(ruleFor(css, ".gl")).not.toContain("max-width");
    const width = window.innerWidth;
    Object.defineProperty(window, "innerWidth", { value: 390, configurable: true });
    try {
      render(<Harness initial="supervisor" />);
      expect(groups("Supervisor").style.maxWidth).toBe("");
    } finally {
      Object.defineProperty(window, "innerWidth", { value: width, configurable: true });
    }
  });
});

describe("an unknown group key", () => {
  it("an Object prototype name like constructor shows the list, not a page", () => {
    render(<Supervisor config={null} transport={null} group="constructor" />);
    expect(screen.getByRole("list", { name: "Supervisor groups" })).toBeInTheDocument();
  });
});
