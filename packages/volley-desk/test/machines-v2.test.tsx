import { readFileSync } from "node:fs";
import path from "node:path";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import axe from "axe-core";
import { describe, expect, it, vi } from "vitest";
import {
  Machines,
  type MachinesProps,
  agentsOnMachines,
  deskMovedTo,
} from "../src/settings/Machines";
import { PeerSignin } from "../src/settings/PeerSigninSheet";
import type { ConfigTransport } from "../src/settings/configTransport";
import { fixFor } from "../src/settings/machineFixes";
import { accountGroups, accountList } from "../src/store/claude";
import type {
  ClaudeAccountPayload,
  MachinePayload,
  ReadinessPayload,
  RolesPayload,
} from "../src/store/types";
import {
  MachinesWindow,
  machineRows as machineRowsOf,
} from "../src/windows/machines/MachinesWindow";
import { NOW, S, machineRecord, placement, readiness, waveState } from "./helpers/desk-msgs";
import { fakePeerOps } from "./helpers/peer-ops";
import { fakeRoleOps } from "./helpers/role-ops";

const iso = (ms: number) => new Date(ms).toISOString();
const flush = () => new Promise((r) => setTimeout(r, 0));

function fakeConfig() {
  return {
    identity: "owner-desk",
    send: vi.fn(async (_patch: Record<string, unknown>) => ({
      applied: true,
      version: 8,
      rejected: [],
    })),
  } satisfies ConfigTransport;
}

const failing: MachinePayload = machineRecord({
  checks: [
    { id: "tool.git", ok: true, severity: "block", detail: "git 2.47.0" },
    { id: "gh.auth", ok: false, severity: "block", detail: "gh is not signed in" },
    { id: "claude.trust", ok: false, severity: "warn", detail: "the repo is not trusted yet" },
  ],
});

const usage: ClaudeAccountPayload = {
  account: "primary@box-a",
  five_hour: { pct: 42, resets_at: null },
  weekly: null,
  agents: [],
  waves: [],
  sampled_at: iso(NOW),
};

function setup(props: Partial<MachinesProps> = {}) {
  const ops = fakePeerOps({ known: vi.fn(() => "admin" as const) });
  const config = fakeConfig();
  const base: MachinesProps = {
    machines: { "box-a": machineRecord() },
    readiness: { "box-a": readiness() },
    hosts: ["box-a"],
    hubUp: true,
    ops,
    configTransport: config,
    now: NOW,
    ...props,
  };
  const view = render(<Machines {...base} />);
  const rerender = (next: Partial<MachinesProps>) =>
    view.rerender(<Machines {...base} {...next} />);
  return { ops: (props.ops as typeof ops | undefined) ?? ops, config, rerender };
}

const card = (name: string) => within(screen.getByRole("article", { name }));
const row = (name: string, id: string) =>
  card(name).getByRole("listitem", { name: new RegExp(`^${id}`) });

describe("machineFixes", () => {
  it("recomputes each check's fix from its id: a command to copy, and whether Repair applies it", () => {
    const ctx = { machine: "box-a", repo: "/srv/work/repo" };
    expect(fixFor("gh.auth", ctx)).toMatchObject({ command: "gh auth login", safe: false });
    expect(fixFor("claude.trust", ctx)?.command).toBe("cd /srv/work/repo && claude");
    expect(fixFor("volley.version", ctx)).toMatchObject({ safe: true });
    expect(fixFor("repo.clone", ctx)).toMatchObject({ safe: true, needsClone: true });
    expect(fixFor("hooks", ctx)).toMatchObject({ safe: true });
    expect(fixFor("tool.tmux", ctx)?.text).toMatch(/install tmux on box-a/);
    expect(fixFor("bun_on_path", ctx)?.text).toMatch(/non-interactive ssh PATH/);
    // #610: push access and the worktree root, per repository.
    expect(fixFor("repo.push", ctx, "o/r")).toEqual({
      text: "give box-a's GitHub account write access to o/r, or sign gh in there as one that has it",
      command: "gh auth login",
      safe: false,
    });
    expect(fixFor("repo.worktrees", ctx, "o/r")).toEqual({
      text: "Repair creates the folder box-a cuts o/r's worktrees under",
      safe: true,
    });
    // #631: a clone's commit identity is the person's to set, in the clone or globally.
    const many = { ...ctx, repos: [{ slug: "o/r", path: "/srv/o/r" }] };
    expect(fixFor("repo.identity", many, "o/r")).toEqual({
      text: "give /srv/o/r on box-a a commit identity: git -C /srv/o/r config user.name … && … user.email …, or a global one with setup's Sign-ins step",
      command:
        'git -C /srv/o/r config user.name "<name>" && git -C /srv/o/r config user.email <email>',
      safe: false,
    });
    // Never "run the doctor by hand": Repair runs it.
    expect(fixFor("something.new", ctx)).toEqual({
      text: "Repair… runs the doctor on box-a again; its plan has this check's fix",
      safe: false,
    });
  });
});

describe("Settings › Machines v2: the machine card", () => {
  it("renders the record's checks as rows: ✓ passing, ✗ a failing block, ! a failing warn, with the Desk's fix", async () => {
    setup({ machines: { "box-a": failing } });
    await act(flush);
    expect(row("box-a", "tool.git")).toHaveTextContent("✓");
    expect(row("box-a", "tool.git")).toHaveTextContent("git 2.47.0");
    const gh = row("box-a", "gh.auth");
    expect(gh).toHaveTextContent("✗");
    expect(gh).toHaveTextContent("gh is not signed in");
    expect(within(gh).getByText("gh auth login")).toBeInTheDocument();
    expect(within(gh).getByRole("button", { name: /Copy/ })).toBeInTheDocument();
    const trust = row("box-a", "claude.trust");
    expect(trust).toHaveTextContent("!");
    expect(within(trust).getByText("cd /srv/work/repo && claude")).toBeInTheDocument();
  });

  it("shows os, cores, memory and disk and the agents against the cap; no usage meter of its own", async () => {
    setup();
    await act(flush);
    const a = card("box-a");
    expect(a.getByText(/linux x64 · 16 cores · 64 GB · 312 GB free/)).toBeInTheDocument();
    expect(a.getByText("2/4 agents")).toBeInTheDocument();
    expect(a.queryByRole("meter")).toBeNull();
  });

  it("a ready, eligible machine reads ready for agents", async () => {
    setup();
    await act(flush);
    expect(card("box-a").getByText("ready for agents")).toBeInTheDocument();
  });

  it("ready: false lists volleyd's reasons", async () => {
    setup({
      readiness: {
        "box-a": readiness({
          ready: false,
          eligible: false,
          reasons: ["gh cannot push to example-org/example-repo", "claude is not signed in"],
        }),
      },
    });
    await act(flush);
    const a = card("box-a");
    expect(a.getByText("not ready")).toBeInTheDocument();
    expect(a.getByText("gh cannot push to example-org/example-repo")).toBeInTheDocument();
    expect(a.getByText("claude is not signed in")).toBeInTheDocument();
    expect(a.queryByText("ready for agents")).toBeNull();
  });

  it("a draining machine reads draining · N agents left", async () => {
    setup({ readiness: { "box-a": readiness({ drain: true, eligible: false }) } });
    await act(flush);
    expect(card("box-a").getByText("draining · 2 agents left")).toBeInTheDocument();
  });

  it("an eligible-no-more machine reads overloaded: with volleyd's reason", async () => {
    setup({
      readiness: {
        "box-a": readiness({ eligible: false, ineligible_reason: "load 2.10 per core (max 1.5)" }),
      },
    });
    await act(flush);
    expect(card("box-a").getByText("overloaded: load 2.10 per core (max 1.5)")).toBeInTheDocument();
  });

  it("a down machine is grey with when it was last seen and why", async () => {
    const down = machineRecord({
      tunnel: "down",
      reason: "heartbeat_timeout",
      last_seen: iso(NOW - 5 * 60 * S),
    });
    setup({ machines: { "box-a": down } });
    await act(flush);
    const article = screen.getByRole("article", { name: "box-a" });
    expect(article).toHaveClass("machine--down");
    expect(card("box-a").getByText("down · last seen 5m ago · no heartbeat")).toBeInTheDocument();
  });

  it("the supervisor's own record is this one: no Repair, Re-pair, Remove or cap editor", async () => {
    const hub = machineRecord({ name: "hub", kind: "supervisor", tunnel: "local" });
    setup({
      machines: { hub, "box-a": machineRecord() },
      readiness: { hub: readiness({ name: "hub", max_agents: 12 }), "box-a": readiness() },
      localName: "hub",
    });
    await act(flush);
    const own = card("hub");
    expect(own.getByText("this one")).toBeInTheDocument();
    expect(own.getByText("local")).toBeInTheDocument();
    expect(own.getByText("2/12 agents")).toBeInTheDocument();
    for (const name of [/Repair/, /Re-pair/, /Remove/]) {
      expect(own.queryByRole("button", { name })).toBeNull();
    }
    expect(own.queryByLabelText(/Max agents/)).toBeNull();
    // Its record replaces the placeholder card.
    expect(screen.queryByRole("article", { name: "This machine" })).toBeNull();
    expect(card("box-a").getByRole("button", { name: "Remove…" })).toBeInTheDocument();
  });

  it("the cap editor sends config_set hosts.<name>.max_agents", async () => {
    const { config } = setup();
    await act(flush);
    const input = card("box-a").getByLabelText("Max agents on box-a");
    expect(input).toHaveValue(4);
    fireEvent.change(input, { target: { value: "6" } });
    await act(async () => {
      fireEvent.click(card("box-a").getByRole("button", { name: "Set" }));
    });
    expect(config.send).toHaveBeenCalledWith(
      { hosts: { "box-a": { max_agents: 6 } } },
      expect.objectContaining({ text: expect.stringContaining("box-a") }),
    );
    expect(card("box-a").getByText(/saved/i)).toBeInTheDocument();
  });

  it("a non-admin session sees no Repair, Re-pair, Remove or cap editor", async () => {
    setup({ ops: fakePeerOps({ known: vi.fn(() => "not-admin" as const) }) });
    await act(flush);
    const a = card("box-a");
    for (const name of [/Repair/, /Re-pair/, /Remove/]) {
      expect(a.queryByRole("button", { name })).toBeNull();
    }
    expect(a.queryByLabelText(/Max agents/)).toBeNull();
  });

  it("Re-pair… creates a code bound to the machine and shows its join --replace command", async () => {
    const { ops } = setup({ host: "hub.local" });
    await act(flush);
    await act(async () => {
      fireEvent.click(card("box-a").getByRole("button", { name: "Re-pair…" }));
    });
    expect(ops.invite).toHaveBeenCalledWith("box-a");
    fireEvent.change(card("box-a").getByLabelText("This machine's ssh address"), {
      target: { value: "owner@hub.local" },
    });
    expect(
      card("box-a").getByText(
        (_, el) =>
          el?.tagName === "CODE" &&
          el.textContent ===
            "volley peer join MXQ4-7KDP --to owner@hub.local --name box-a --replace",
      ),
    ).toBeInTheDocument();
  });

  it("a verdict reads as stale while volleyd is not live", async () => {
    setup({ hubUp: false });
    await act(flush);
    expect(card("box-a").getByText(/ready for agents/)).toHaveTextContent(
      "ready for agents · volleyd is not live",
    );
  });

  it("a card with no verdict yet says so instead of guessing", async () => {
    setup({ readiness: {} });
    await act(flush);
    expect(card("box-a").getByText(/no verdict from volleyd yet/)).toBeInTheDocument();
  });
});

describe("Add a machine: steps 3–5", () => {
  const boxC = machineRecord({
    name: "box-c",
    auth: { gh: "ok", claude: "not_signed_in", trust: "missing" },
    checks: [
      { id: "tool.git", ok: true, severity: "block", detail: "git 2.47.0" },
      { id: "claude.signin", ok: false, severity: "block", detail: "claude is not signed in" },
    ],
  });
  const notReady = readiness({
    name: "box-c",
    ready: false,
    eligible: false,
    reasons: ["claude is not signed in on box-c"],
  });

  async function joined(props: Partial<MachinesProps> = {}) {
    const ops = fakePeerOps({ known: vi.fn(() => "admin" as const) });
    const config = fakeConfig();
    const base: MachinesProps = {
      machines: { "box-a": machineRecord() },
      readiness: { "box-a": readiness() },
      hosts: ["box-a", "box-c"],
      hubUp: true,
      ops,
      configTransport: config,
      now: NOW,
      ...props,
    };
    const r = render(<Machines {...base} />);
    await act(flush);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "+ Add a machine" }));
    });
    const join = (more: Partial<MachinesProps>) => r.rerender(<Machines {...base} {...more} />);
    join({
      machines: { "box-a": machineRecord(), "box-c": boxC },
      readiness: { "box-a": readiness(), "box-c": notReady },
    });
    return { ops, config, join };
  }

  const pair = () => within(document.querySelector(".pair--machine") as HTMLElement);

  it("step 3 shows the new machine's checks and readiness from its first heartbeat, with Repair", async () => {
    const { ops } = await joined();
    expect(pair().getByRole("heading", { name: /box-c joined/ })).toBeInTheDocument();
    const rows = within(pair().getByRole("list", { name: "Checks on box-c" }));
    expect(rows.getByRole("listitem", { name: /^claude\.signin/ })).toHaveTextContent("✗");
    expect(pair().getByText("claude is not signed in on box-c")).toBeInTheDocument();
    fireEvent.click(pair().getByRole("button", { name: "Repair…" }));
    expect(screen.getByRole("dialog", { name: "Repair box-c" })).toBeInTheDocument();
    expect(ops.doctor).toHaveBeenCalledWith("box-c", { fix: false });
  });

  it("step 4 gives the manual Claude sign-in steps and Check again runs the doctor", async () => {
    const { ops } = await joined();
    fireEvent.click(pair().getByRole("button", { name: "Next" }));
    expect(pair().getByRole("heading", { name: "Claude on box-c" })).toBeInTheDocument();
    expect(pair().getByText(/with the account its agents should use/)).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(pair().getByRole("button", { name: "Check again" }));
    });
    expect(ops.doctor).toHaveBeenCalledWith("box-c", { fix: false });
  });

  it("step 4 fills the sign-in slot when the Desk has one, and says so once Claude is signed in", async () => {
    const { join } = await joined({
      signIn: (m) => <button type="button">Sign in on {m}</button>,
    });
    fireEvent.click(pair().getByRole("button", { name: "Next" }));
    expect(pair().getByRole("button", { name: "Sign in on box-c" })).toBeInTheDocument();
    join({
      machines: {
        "box-a": machineRecord(),
        "box-c": { ...boxC, auth: { gh: "ok", claude: "signed_in", trust: "ok" } },
      },
      readiness: { "box-a": readiness(), "box-c": readiness({ name: "box-c" }) },
      signIn: (m) => <button type="button">Sign in on {m}</button>,
    });
    expect(pair().getByText("Claude Code is signed in on box-c.")).toBeInTheDocument();
  });

  it("step 4's sign-in is Sign in on <machine>: the remote Claude sign-in sheet", async () => {
    const control = vi.fn(async () => ({ ok: true, result: {} }));
    await joined({
      signIn: (m) => <PeerSignin machine={m} signin={undefined} control={control} ops={null} />,
    });
    fireEvent.click(pair().getByRole("button", { name: "Next" }));
    await act(async () => {
      fireEvent.click(pair().getByRole("button", { name: "Sign in on box-c" }));
    });
    expect(screen.getByRole("dialog", { name: "Sign in on box-c" })).toBeInTheDocument();
    expect(control).toHaveBeenCalledWith(
      "claude_signin",
      { acct: "primary@box-c" },
      expect.any(String),
      expect.any(Number),
    );
  });

  it("step 5 sums it up and Done sets max_agents", async () => {
    const { config, join } = await joined();
    join({
      machines: { "box-a": machineRecord(), "box-c": boxC },
      readiness: { "box-a": readiness(), "box-c": readiness({ name: "box-c" }) },
    });
    fireEvent.click(pair().getByRole("button", { name: "Next" }));
    fireEvent.click(pair().getByRole("button", { name: "Next" }));
    expect(pair().getByRole("heading", { name: "box-c is ready for agents" })).toBeInTheDocument();
    expect(pair().getByText(/placement: auto/)).toBeInTheDocument();
    fireEvent.change(pair().getByLabelText("Max agents on box-c"), { target: { value: "6" } });
    await act(async () => {
      fireEvent.click(pair().getByRole("button", { name: "Done" }));
    });
    expect(config.send).toHaveBeenCalledWith(
      { hosts: { "box-c": { max_agents: 6 } } },
      expect.anything(),
    );
    expect(document.querySelector(".pair--machine")).toBeNull();
  });

  it("a refused Done keeps step 5 open and says why", async () => {
    const { config, join } = await joined();
    config.send.mockResolvedValueOnce({
      applied: false,
      rejected: [{ path: "hosts.box-c.max_agents", reason: "box-c is not a host" }],
    } as never);
    join({
      machines: { "box-a": machineRecord(), "box-c": boxC },
      readiness: { "box-a": readiness(), "box-c": readiness({ name: "box-c" }) },
    });
    fireEvent.click(pair().getByRole("button", { name: "Next" }));
    fireEvent.click(pair().getByRole("button", { name: "Next" }));
    fireEvent.change(pair().getByLabelText("Max agents on box-c"), { target: { value: "6" } });
    await act(async () => {
      fireEvent.click(pair().getByRole("button", { name: "Done" }));
    });
    expect(pair().getByRole("alert")).toHaveTextContent("box-c is not a host");
  });
});

describe("agentsOnMachines", () => {
  it("lists each machine's live agents from the waves' placed tasks", () => {
    const s = waveState({
      tasks: [
        {
          id: "T1",
          issue: 1,
          stage: "implement",
          agents: { implementer: "impl-1" },
          host: "box-a",
          placement: placement(),
        },
        {
          id: "T2",
          issue: 2,
          stage: "spec_review",
          agents: { implementer: "impl-2", spec_reviewer: "rev-2" },
          placement: placement({ host: "hub" }),
        },
        { id: "T3", issue: 3, stage: "done", agents: { implementer: "impl-3" }, host: "box-a" },
      ],
    });
    expect(agentsOnMachines([s])).toEqual({ "box-a": ["impl-1"], hub: ["impl-2", "rev-2"] });
  });
});

describe("phone width (390 px)", () => {
  it("stacks the cards, wraps the rows and makes the sheets full-screen", () => {
    const css = readFileSync(path.join(__dirname, "../src/styles/machines.css"), "utf8");
    const phone = css.slice(css.indexOf("@media (max-width: 720px)"));
    expect(phone).toMatch(/\.machines\s*\{[^}]*grid-template-columns:\s*1fr/);
    expect(css).toMatch(/\.m-check\s*\{[^}]*flex-wrap:\s*wrap/);
    expect(phone).toMatch(/\.m-sheet\s*\{[^}]*inset:\s*0/);
  });
});

describe("Machines focus (the agent window's machine chip)", () => {
  it("scrolls the focused machine's card into view once, on mount", () => {
    const seen: Element[] = [];
    const spy = vi.fn(function (this: Element) {
      seen.push(this);
    });
    // jsdom has no scrollIntoView.
    Object.defineProperty(Element.prototype, "scrollIntoView", { value: spy, configurable: true });
    try {
      setup({
        machines: { "box-a": machineRecord(), "box-b": machineRecord({ name: "box-b" }) },
        hosts: ["box-a", "box-b"],
        focus: "box-b",
      });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(seen[0]).toBe(screen.getByRole("article", { name: "box-b" }));
    } finally {
      Reflect.deleteProperty(Element.prototype, "scrollIntoView");
    }
  });

  it("a second click on the same machine's chip (a new focusSeq) scrolls to its card again", () => {
    const spy = vi.fn();
    Object.defineProperty(Element.prototype, "scrollIntoView", { value: spy, configurable: true });
    try {
      const { rerender } = setup({ focus: "box-a", focusSeq: 1 });
      expect(spy).toHaveBeenCalledTimes(1);
      rerender({ focus: "box-a", focusSeq: 1 });
      expect(spy).toHaveBeenCalledTimes(1);
      rerender({ focus: "box-a", focusSeq: 2 });
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      Reflect.deleteProperty(Element.prototype, "scrollIntoView");
    }
  });

  it("the supervisor's own machine scrolls to its card (the hub card until it has a record)", () => {
    const spy = vi.fn();
    Object.defineProperty(Element.prototype, "scrollIntoView", { value: spy, configurable: true });
    try {
      setup({ localName: "studio", focus: "studio" });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.contexts[0]).toBe(screen.getByRole("article", { name: "This machine" }));
    } finally {
      Reflect.deleteProperty(Element.prototype, "scrollIntoView");
    }
  });
});

describe("the local agents chip (the supervisor's own card)", () => {
  const hub = machineRecord({ name: "hub", kind: "supervisor", tunnel: "local" });
  const withLocal = (local_agents?: ReadinessPayload["local_agents"]) =>
    setup({
      machines: { hub, "box-a": machineRecord() },
      readiness: {
        hub: readiness({ name: "hub", ...(local_agents ? { local_agents } : {}) }),
        // A peer's verdict never carries it; even if one did, a peer card shows no chip.
        "box-a": readiness({ local_agents: { mode: "always", active: false } }),
      },
      localName: "hub",
      onOpenSetting: vi.fn(),
    });
  const chip = () => card("hub").queryByRole("button", { name: /^Local agents:/ });

  it.each([
    [{ mode: "fallback", active: false }, "fallback"],
    [{ mode: "fallback", active: true }, "fallback · active"],
    [{ mode: "always", active: false }, "always"],
    [{ mode: "never", active: false }, "never"],
  ] as const)("reads %j as %s", async (local, text) => {
    withLocal(local);
    await act(flush);
    expect(chip()).toHaveTextContent(text);
    expect(chip()).toHaveAccessibleName(`Local agents: ${text}`);
  });

  it("titles the chip with volleyd's why", async () => {
    withLocal({ mode: "fallback", active: true, why: "box-a: tunnel down (readiness)" });
    await act(flush);
    expect(chip()).toHaveAttribute("title", "box-a: tunnel down (readiness)");
  });

  it("is absent from an older supervisor's verdict and never on a peer card", async () => {
    withLocal(undefined);
    await act(flush);
    expect(chip()).toBeNull();
    expect(card("box-a").queryByRole("button", { name: /^Local agents:/ })).toBeNull();
  });

  it("a click asks for the fleet.local_agents setting", async () => {
    const onOpenSetting = vi.fn();
    setup({
      machines: { hub },
      readiness: {
        hub: readiness({ name: "hub", local_agents: { mode: "always", active: false } }),
      },
      localName: "hub",
      onOpenSetting,
    });
    await act(flush);
    fireEvent.click(card("hub").getByRole("button", { name: "Local agents: always" }));
    expect(onOpenSetting).toHaveBeenCalledWith("fleet.local_agents");
  });

  it("passes axe", async () => {
    withLocal({ mode: "fallback", active: true, why: "box-a eligible" });
    await act(flush);
    const results = await axe.run(screen.getByRole("article", { name: "hub" }), {
      rules: { "color-contrast": { enabled: false } },
    });
    expect(results.violations.map((v) => v.id)).toEqual([]);
  });
});

describe("Settings › Machines v2: the machine card's Claude accounts", () => {
  const personal: ClaudeAccountPayload = {
    account: "personal",
    label: "Personal",
    plan: "pro",
    email: "p@example.com",
    five_hour: null,
    weekly: null,
    agents: [],
    waves: [],
    sampled_at: iso(NOW),
  };
  const URL = "https://claude.com/cai/oauth/authorize?redirect_uri=localhost&state=s";

  function withAccounts(props: Partial<MachinesProps> = {}) {
    const machines = { "box-a": machineRecord() };
    const records = { "primary@box-a": usage, personal };
    const control = vi.fn(async (op: string) =>
      op === "claude_account_add"
        ? { ok: true, result: { acct: "personal-box-a@box-a", url: URL } }
        : ({ ok: true } as { ok: boolean; result?: unknown }),
    );
    const r = setup({
      machines,
      localName: "hub",
      signIn: (m) => <button type="button">Sign in on {m}</button>,
      claude: {
        groups: accountGroups(accountList(records), machines, "hub"),
        signins: {},
        control,
      },
      ...props,
    });
    return { ...r, control };
  }
  const block = () =>
    within(card("box-a").getByRole("list", { name: "Claude accounts on box-a" })).getAllByRole(
      "listitem",
    );

  it("lists each account with a held or missing dot, and Sign in on the machine for a missing one", async () => {
    withAccounts();
    await act(flush);
    const [held, missing] = block();
    expect(held).toHaveTextContent("primary@box-a");
    expect(held).toHaveTextContent("default login");
    expect(held?.querySelector(".cc-dot--in")).not.toBeNull();
    expect(missing).toHaveTextContent("Personal");
    expect(missing).toHaveTextContent("p•••@example.com");
    expect(missing).toHaveTextContent("pro");
    expect(missing?.querySelector(".cc-dot--in")).toBeNull();
    expect(
      within(missing as HTMLElement).getByRole("button", {
        name: "Sign in on box-a with Personal",
      }),
    ).toBeEnabled();
    // The default login's sign-in button stays; a row says its sign-in state, never a figure.
    expect(card("box-a").getByRole("button", { name: "Sign in on box-a" })).toBeInTheDocument();
    expect(held).toHaveTextContent("signed in");
    for (const row of block()) expect(row.textContent).not.toMatch(/%|5h|7d|Fable/);
    expect(card("box-a").queryByRole("meter")).toBeNull();
  });

  it("a held account's row names the account and its state only, no figures or ages", async () => {
    const at = (min: number) => iso(NOW - min * 60_000);
    const machines = { "box-a": machineRecord() };
    const records = {
      "primary@box-a": {
        ...usage,
        email: "owner@example.com",
        sampled_at: at(180),
      },
      work: {
        ...usage,
        account: "work",
        label: "Work",
        email: "owner@example.com",
        five_hour: { pct: 37, resets_at: null },
        weekly: { pct: 56, resets_at: null },
        model_weekly: { fable: { pct: 12, resets_at: null } },
        probe: { machine: "hub", state: "ok" as const, attempted_at: at(4), read_at: at(4) },
        sampled_at: at(4),
      },
    };
    withAccounts({
      machines,
      claude: {
        groups: accountGroups(accountList(records), machines, "hub"),
        signins: {},
        control: null,
      },
    });
    await act(flush);
    const [row] = block();
    expect(row).toHaveTextContent("Work");
    expect(row).toHaveTextContent("signed in");
    expect(row?.textContent).not.toMatch(/%|sampled|ago/);
  });

  it("Sign in on box-a opens the sign-in for that account there", async () => {
    const { control } = withAccounts();
    await act(flush);
    await act(async () => {
      fireEvent.click(
        card("box-a").getByRole("button", { name: "Sign in on box-a with Personal" }),
      );
    });
    expect(control).toHaveBeenCalledWith(
      "claude_account_add",
      { label: "Personal (box-a)", machine: "box-a" },
      expect.any(String),
      expect.any(Number),
    );
    const dialog = within(screen.getByRole("region", { name: "Add Claude account" }));
    expect(dialog.getByRole("heading", { level: 3 })).toHaveTextContent(
      "Sign in with p•••@example.com on box-a",
    );
    expect(dialog.getByRole("link", { name: /Open Anthropic sign-in/ })).toHaveAttribute(
      "href",
      URL,
    );
  });

  it("no button while the tunnel is down or without control", async () => {
    const down = { "box-a": machineRecord({ tunnel: "down" }) };
    const records = { "primary@box-a": usage, personal };
    withAccounts({
      machines: down,
      claude: {
        groups: accountGroups(accountList(records), down, "hub"),
        signins: {},
        control: vi.fn(),
      },
    });
    await act(flush);
    const missing = block().find((li) => li.textContent?.includes("Personal"));
    expect(within(missing as HTMLElement).getByRole("button")).toBeDisabled();
    expect(missing).toHaveTextContent("tunnel down");
  });

  it("read-only: the rows without a button", async () => {
    const records = { "primary@box-a": usage, personal };
    const machines = { "box-a": machineRecord() };
    withAccounts({
      claude: {
        groups: accountGroups(accountList(records), machines, "hub"),
        signins: {},
        control: null,
      },
    });
    await act(flush);
    expect(block()).toHaveLength(2);
    expect(card("box-a").queryByRole("button", { name: /with Personal/ })).toBeNull();
  });

  it("passes axe with the block", async () => {
    withAccounts();
    await act(flush);
    const res = await axe.run(screen.getByRole("article", { name: "box-a" }), {
      rules: { "color-contrast": { enabled: false } },
    });
    expect(res.violations.map((v) => v.id)).toEqual([]);
  });
});

describe("Settings › Machines v2: machine roles (SPEC §4.6.24)", () => {
  const hub = machineRecord({ name: "hub", kind: "supervisor", tunnel: "local" });
  const roles = (over: Partial<RolesPayload> = {}): RolesPayload => ({
    broker: { machine: "hub", address: { ssh: null, mqtt_port: 1883, ws_port: 9001 }, lan: false },
    supervisor: { machine: "hub" },
    desk: { machine: "box-a", url: "http://box-a:5199" },
    version: 2,
    updated_at: iso(NOW),
    updated_by: "admin",
    ...over,
  });
  const withRoles = (props: Partial<MachinesProps> = {}) => {
    const roleOps = fakeRoleOps();
    const r = setup({
      machines: { hub, "box-a": machineRecord() },
      readiness: { hub: readiness({ name: "hub" }), "box-a": readiness() },
      localName: "hub",
      roles: roles(),
      roleOps,
      ...props,
    });
    return { ...r, roleOps };
  };
  const chips = (name: string) =>
    within(card(name).getByRole("list", { name: `Roles on ${name}` }))
      .getAllByRole("listitem")
      .map((li) => li.textContent);
  const moveMenu = (name: string) =>
    card(name).queryByRole("button", { name: "Move a role here…" });

  it("the own card shows the chips broker and supervisor; a peer holding desk shows one chip", async () => {
    withRoles();
    await act(flush);
    expect(chips("hub")).toEqual(["broker", "supervisor"]);
    expect(chips("box-a")).toEqual(["desk"]);
  });

  it("the own card holding all three shows broker, supervisor, desk", async () => {
    withRoles({ roles: roles({ desk: { machine: "hub", url: "http://localhost:5199" } }) });
    await act(flush);
    expect(chips("hub")).toEqual(["broker", "supervisor", "desk"]);
    expect(card("box-a").getByText(/no roles/)).toBeInTheDocument();
  });

  it("the section's summary line reads the three", async () => {
    withRoles();
    await act(flush);
    expect(screen.getByText("broker · hub — supervisor · hub — desk · box-a")).toBeInTheDocument();
  });

  it("no Roles row and no summary before volleyd's record arrives", async () => {
    withRoles({ roles: undefined });
    await act(flush);
    expect(card("hub").queryByRole("list", { name: "Roles on hub" })).toBeNull();
    expect(moveMenu("box-a")).toBeNull();
  });

  it("the menu lists only the roles the machine does not hold and opens the sheet", async () => {
    const { roleOps } = withRoles();
    await act(flush);
    fireEvent.click(moveMenu("box-a") as HTMLElement);
    const items = card("box-a")
      .getAllByRole("menuitem")
      .map((b) => b.textContent);
    expect(items).toEqual(["the broker", "the supervisor"]);
    fireEvent.click(card("box-a").getByRole("menuitem", { name: "the broker" }));
    expect(screen.getByRole("dialog", { name: "Move the broker to box-a" })).toBeInTheDocument();
    await act(flush);
    expect(roleOps.plan).toHaveBeenCalledWith({ role: "broker", to: "box-a" });
  });

  it("the own card offers the Desk back", async () => {
    withRoles();
    await act(flush);
    fireEvent.click(moveMenu("hub") as HTMLElement);
    expect(
      card("hub")
        .getAllByRole("menuitem")
        .map((b) => b.textContent),
    ).toEqual(["the Desk"]);
  });

  it("is absent for a machine that holds every role", async () => {
    withRoles({ roles: roles({ desk: { machine: "hub", url: "http://localhost:5199" } }) });
    await act(flush);
    expect(moveMenu("hub")).toBeNull();
  });

  it("is absent for a watch (non-admin) session and on a down machine", async () => {
    withRoles({ ops: fakePeerOps({ known: vi.fn(() => "not-admin" as const) }) });
    await act(flush);
    expect(moveMenu("box-a")).toBeNull();
    expect(moveMenu("hub")).toBeNull();
  });

  it("is absent on a down machine", async () => {
    withRoles({
      machines: { hub, "box-a": machineRecord({ tunnel: "down", reason: "heartbeat_timeout" }) },
    });
    await act(flush);
    expect(moveMenu("box-a")).toBeNull();
  });

  it("a finished move closes the sheet with a notice on the section", async () => {
    withRoles();
    await act(flush);
    fireEvent.click(moveMenu("hub") as HTMLElement);
    fireEvent.click(card("hub").getByRole("menuitem", { name: "the Desk" }));
    await act(flush);
    fireEvent.click(screen.getByRole("button", { name: "Move…" }));
    fireEvent.click(screen.getByRole("button", { name: "Move now" }));
    await act(flush);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText(/The Desk runs on hub/)).toBeInTheDocument();
  });

  it.each(["volley", "lighter"])("passes axe in the %s theme", async (theme) => {
    document.documentElement.dataset.theme = theme;
    try {
      withRoles();
      await act(flush);
      fireEvent.click(moveMenu("box-a") as HTMLElement);
      const res = await axe.run(screen.getByRole("article", { name: "box-a" }), {
        rules: { "color-contrast": { enabled: false } },
      });
      expect(res.violations.map((v) => v.id)).toEqual([]);
    } finally {
      delete document.documentElement.dataset.theme;
    }
  });

  it("the role chips use the theme tokens in machines.css, in dark and light", () => {
    const css = readFileSync(path.join(__dirname, "../src/styles/machines.css"), "utf8");
    const rule = css.match(/\.m-role\s*\{[^}]*\}/)?.[0] ?? "";
    expect(rule).toMatch(/var\(--/);
    expect(rule).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  });
});

describe("the Machines window: role letters", () => {
  it("a row carries the letters of the roles its machine holds", () => {
    const state = {
      config: { fleet: { local_name: "hub" }, hosts: { "box-a": {} } },
      machines: {
        hub: machineRecord({ name: "hub", kind: "supervisor", tunnel: "local" }),
        "box-a": machineRecord(),
      },
      roles: {
        broker: {
          machine: "hub",
          address: { ssh: null, mqtt_port: 1883, ws_port: 9001 },
          lan: false,
        },
        supervisor: { machine: "hub" },
        desk: { machine: "hub", url: "http://localhost:5199" },
        version: 1,
        updated_at: iso(NOW),
        updated_by: "volleyd-defaults",
      },
    } as unknown as Parameters<typeof machineRowsOf>[0];
    render(
      <MachinesWindow
        rows={machineRowsOf(state, true)}
        now={NOW}
        frame={{
          pos: { x: 0, y: 0 },
          z: 1,
          scale: 1,
          chrome: "glass",
          onMove: () => {},
          onFocus: () => {},
        }}
        onOpen={() => {}}
        onClose={() => {}}
      />,
    );
    const hubRow = screen.getByRole("button", {
      name: "this machine: open in Settings › Machines",
    });
    expect(hubRow.querySelector(".mrow-roles")?.textContent).toBe("B S D");
    const boxRow = screen.getByRole("button", { name: "box-a: open in Settings › Machines" });
    expect(boxRow.querySelector(".mrow-roles")).toBeNull();
    expect(
      screen.getByText(/this machine: .* — runs the broker, the supervisor and the Desk/),
    ).toBeInTheDocument();
  });
});

describe("deskMovedTo: the banner on the Desk's old address", () => {
  const roles: RolesPayload = {
    broker: { machine: "hub", address: { ssh: null, mqtt_port: 1883, ws_port: 9001 }, lan: false },
    supervisor: { machine: "hub" },
    desk: { machine: "box-a", url: "http://box-a:5199/" },
    version: 2,
    updated_at: iso(NOW),
    updated_by: "admin",
  };
  const done = {
    "mv-1": {
      move_id: "mv-1",
      role: "desk" as const,
      from: "hub",
      to: "box-a",
      status: "done" as const,
      steps: [],
      since: iso(NOW),
    },
  };

  it("names the new address on another origin once a Desk move there is done", () => {
    expect(deskMovedTo(roles, done, "http://localhost:5199")).toBe("http://box-a:5199/");
  });

  it("is null at the new address, before the move is done, or without a record", () => {
    expect(deskMovedTo(roles, done, "http://box-a:5199")).toBeNull();
    const running = { "mv-1": { ...done["mv-1"], status: "running" as const } };
    expect(deskMovedTo(roles, running, "http://localhost:5199")).toBeNull();
    expect(deskMovedTo(roles, {}, "http://localhost:5199")).toBeNull();
    expect(deskMovedTo(undefined, done, "http://localhost:5199")).toBeNull();
  });
});

describe("Add a bare machine… (machine_add)", () => {
  it("an admin opens the sheet from the section; it sends machine_add and closes on Done", async () => {
    const { ops } = setup({
      signIn: (m) => (
        <button type="button" className="btn btn--blue">
          Sign in on {m}
        </button>
      ),
    });
    await act(flush);
    fireEvent.click(screen.getByRole("button", { name: "Add a bare machine…" }));
    const dialog = within(screen.getByRole("dialog", { name: "Add a bare machine" }));
    fireEvent.change(dialog.getByLabelText("Address"), { target: { value: "dev@box-c" } });
    fireEvent.change(dialog.getByLabelText("Password", { selector: "input[type=password]" }), {
      target: { value: "hunter2" },
    });
    await act(async () => {
      fireEvent.click(dialog.getByRole("button", { name: "Add dev@box-c" }));
    });
    expect(ops.machineAdd).toHaveBeenCalledWith(
      { address: "dev@box-c", password: "hunter2" },
      expect.any(Function),
    );
    const done = within(screen.getByRole("dialog"));
    expect(done.getByRole("heading", { name: "box-a is ready for agents" })).toBeInTheDocument();
    fireEvent.click(done.getByRole("button", { name: "Done" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("is not offered to a read-only session", async () => {
    setup({ ops: null });
    await act(flush);
    expect(screen.queryByRole("button", { name: "Add a bare machine…" })).toBeNull();
  });
});
