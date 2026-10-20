import { readFileSync } from "node:fs";
import path from "node:path";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Machines, type MachinesProps, agentsOnMachines } from "../src/settings/Machines";
import { PeerSignin } from "../src/settings/PeerSigninSheet";
import type { ConfigTransport } from "../src/settings/configTransport";
import { fixFor } from "../src/settings/machineFixes";
import type { ClaudeAccountPayload, MachinePayload } from "../src/store/types";
import { NOW, S, machineRecord, placement, readiness, waveState } from "./helpers/desk-msgs";
import { fakePeerOps } from "./helpers/peer-ops";

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
    expect(fixFor("something.new", ctx)?.command).toBe("volley peer doctor");
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

  it("shows os, cores, memory and disk, the agents against the cap and the 5-hour usage of primary@<name>", async () => {
    setup({ accounts: { "primary@box-a": usage } });
    await act(flush);
    const a = card("box-a");
    expect(a.getByText(/linux x64 · 16 cores · 64 GB · 312 GB free/)).toBeInTheDocument();
    expect(a.getByText("2/4 agents")).toBeInTheDocument();
    expect(a.getByRole("meter", { name: "primary@box-a 5-hour usage" })).toHaveAttribute(
      "aria-valuenow",
      "42",
    );
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
