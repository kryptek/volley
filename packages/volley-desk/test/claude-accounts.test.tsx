import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import axe from "axe-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App from "../src/App";
import { LOOK_STORAGE_KEY } from "../src/look/useLook";
import {
  ClaudeAccounts,
  type ClaudeAccountsProps,
  type ControlFn,
  signInPreset,
  withSignIns,
} from "../src/settings/ClaudeAccounts";
import type { AccountGroup } from "../src/store/claude";
import { DeskStoreProvider } from "../src/store/context";
import { initialState, reduceAll } from "../src/store/reducer";
import type {
  ClaudeAccountPayload,
  ConfigPayload,
  DecisionPayload,
  DeskMessage,
} from "../src/store/types";

// The demo client, passed through: a test can feed the demo store (`demoFeed.apply`) and count
// what the Desk asks volleyd's registry (`demoFeed.asks`).
const demoFeed = vi.hoisted(() => ({
  apply: null as ((msgs: DeskMessage[]) => void) | null,
  asks: [] as string[],
}));
vi.mock("../src/steer/demoClient", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/steer/demoClient")>();
  return {
    ...real,
    createDemoSteerClient: (apply: (msgs: DeskMessage[]) => void, ...rest: unknown[]) => {
      demoFeed.apply = apply;
      return (real.createDemoSteerClient as (...a: unknown[]) => unknown)(apply, ...rest);
    },
    demoReadControl: (control: Parameters<typeof real.demoReadControl>[0]) => {
      const read = real.demoReadControl(control);
      return ((op, ...rest) => {
        demoFeed.asks.push(op);
        return read(op, ...rest);
      }) as typeof read;
    },
  };
});

const NOW = Date.parse("2026-10-18T14:06:00.000Z");
/** When a registry profile finished its sign-in. */
const SIGNED = "2026-10-18T12:00:00.000Z";

const work: ClaudeAccountPayload = {
  account: "work",
  label: "Work",
  plan: "max",
  five_hour: { pct: 91, resets_at: "2026-10-18T18:10:00.000Z" },
  weekly: { pct: 43, resets_at: "2026-10-21T09:00:00.000Z" },
  agents: ["w1-t1-implementer-1", "w1-t2-implementer-1"],
  waves: ["w1"],
  sampled_at: "2026-10-18T14:06:00.000Z",
};

const personal: ClaudeAccountPayload = {
  account: "personal",
  label: "Personal",
  plan: "pro",
  five_hour: { pct: 12, resets_at: "2026-10-18T16:00:00.000Z" },
  weekly: { pct: 22, resets_at: null },
  agents: [],
  waves: [],
  sampled_at: "2026-10-18T14:05:00.000Z",
};

const limit: DecisionPayload = {
  decision_id: "d-7k2m9q4x",
  wave: "w1",
  task: null,
  kind: "account_limit",
  question: "Needs you: Claude account work is at 91% of its 5-hour window.",
  options: ["move wave w1 to personal", "not now"],
  opened_at: "2026-10-18T14:06:01.000Z",
  acct: "work",
  pct: 91,
  resets_at: "2026-10-18T18:10:00.000Z",
  suggested: "personal",
};

const agentLimit: DecisionPayload = {
  decision_id: "w1-t1-agent_account_limit-1",
  wave: "w1",
  task: "T1",
  kind: "agent_account_limit",
  question: "w1-t1-implementer-1 runs under work, at 91% of its 5-hour window.",
  options: ["move w1-t1-implementer-1 to personal", "not now"],
  opened_at: "2026-10-18T14:06:01.000Z",
  agent_id: "w1-t1-implementer-1",
  role: "implementer",
  window: "five_hour",
  acct: "work",
  pct: 91,
  resets_at: null,
  suggested: "personal",
};

const config = {
  version: 3,
  updated_at: "2026-10-18T12:00:00.000Z",
  updated_by: "desk",
  claude: { default_account: "most_headroom", warn_at_pct: 85 },
} as ConfigPayload;

function msg(topic: string, channel: string, type: string, payload: unknown): DeskMessage {
  return {
    topic,
    envelope: {
      schema_version: "0.1",
      agent_id: "volleyd",
      channel,
      type,
      wall_time: new Date(NOW).toISOString(),
      payload,
    },
    receivedAt: NOW,
  };
}

const accountMsg = (p: ClaudeAccountPayload) =>
  msg(
    `volley/_system/claude-accounts/${p.account}`,
    "_system/claude-accounts",
    "claude_account",
    p,
  );

const signinMsg = (acct: string, type: string, payload: Record<string, unknown>) =>
  msg(`volley/_system/claude/${acct}/signin`, `_system/claude/${acct}/signin`, type, {
    acct,
    ...payload,
  });

function setup(extra: DeskMessage[] = [], props: Partial<ClaudeAccountsProps> = {}) {
  const state = reduceAll(initialState(), [accountMsg(work), accountMsg(personal), ...extra]);
  const control = vi.fn(async () => ({ ok: true }) as { ok: boolean; result?: unknown });
  const view = (s = state, more: Partial<ClaudeAccountsProps> = {}) => (
    <ClaudeAccounts
      accounts={s.claudeAccounts ?? {}}
      signins={s.signins ?? {}}
      config={config}
      control={control}
      configTransport={null}
      now={NOW}
      group="accounts"
      {...props}
      {...more}
    />
  );
  const r = render(view());
  return { ...r, state, control, view };
}

/** An open decision on wave w1, as volleyd retains it. */
const decisionMsg = (d: DecisionPayload) =>
  msg(`volley/_waves/w1/decisions/${d.decision_id}`, "_waves/decisions", "decision", d);

describe("reducer: Claude accounts and sign-in events", () => {
  it("keeps the retained account records and forgets a cleared one", () => {
    const s = reduceAll(initialState(), [accountMsg(work), accountMsg(personal)]);
    expect(Object.keys(s.claudeAccounts ?? {})).toEqual(["work", "personal"]);
    const cleared = reduceAll(s, [
      { topic: "volley/_system/claude-accounts/work", envelope: null, receivedAt: NOW },
    ]);
    expect(Object.keys(cleared.claudeAccounts ?? {})).toEqual(["personal"]);
  });

  it("folds sign-in events per account: url → waiting, then done", () => {
    let s = reduceAll(initialState(), [
      signinMsg("team", "claude_signin_url", { url: "https://example.com/oauth", flow: "browser" }),
    ]);
    expect(s.signins?.team).toMatchObject({ state: "waiting", url: "https://example.com/oauth" });
    s = reduceAll(s, [signinMsg("team", "claude_signin_done", { plan: "max" })]);
    expect(s.signins?.team).toMatchObject({ state: "done", plan: "max" });
    s = reduceAll(s, [signinMsg("other", "claude_signin_failed", { reason: "timed out" })]);
    expect(s.signins?.other).toMatchObject({ state: "failed", reason: "timed out" });
  });
});

describe("ClaudeAccounts", () => {
  it("renders one card per account record with both meters and their resets", () => {
    setup();
    const cards = screen.getAllByRole("article");
    // Work, Personal and this machine's own login (the primary), which has not reported yet.
    expect(cards).toHaveLength(3);
    const w = within(screen.getByRole("article", { name: "Work" }));
    expect(w.getByText("max")).toHaveClass("chip");
    const five = w.getByRole("meter", { name: "5-hour" });
    expect(five).toHaveAttribute("aria-valuenow", "91");
    expect(five.closest(".meter")).toHaveTextContent("91%");
    expect(five.closest(".meter")).toHaveTextContent("resets in 4h 4m");
    expect(five.closest(".meter")?.querySelector(".meter-pct")).toHaveClass("meter-hot");
    const week = w.getByRole("meter", { name: "7-day" });
    expect(week.closest(".meter")).toHaveTextContent("43%");
    expect(week.closest(".meter")).toHaveTextContent("resets in 2d 18h");
    const p = within(screen.getByRole("article", { name: "Personal" }));
    expect(p.getByRole("meter", { name: "5-hour" }).closest(".meter")).toHaveTextContent("12%");
  });

  it("renders no Needs-you banner, even with an open account_limit or agent_account_limit", () => {
    // The wave's limit is its window's banner, the agent's its window's: none here.
    const { container } = setup([decisionMsg(limit), decisionMsg(agentLimit)]);
    expect(container.querySelector(".needs-you")).toBeNull();
    expect(screen.queryByText(/Needs you/)).toBeNull();
    expect(screen.queryByRole("button", { name: /Move to|not now/i })).toBeNull();
  });

  it("Add: the code-page link with its QR code, the one box, then Signed in as the masked e-mail", async () => {
    const { control, rerender, view, state } = setup();
    const CODE_URL =
      "https://claude.com/cai/oauth/authorize?code=true&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&state=s";
    control.mockResolvedValueOnce({ ok: true, result: { acct: "team", account: "team" } });
    fireEvent.click(screen.getByRole("button", { name: "+ Add Claude account" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Account label" }), {
      target: { value: "Team" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Sign in on this machine" }));
    });
    const waiting = reduceAll(state, [
      signinMsg("team", "claude_signin_url", {
        url: CODE_URL,
        flow: "manual_code",
        manual_url: CODE_URL,
        callback_url: "https://claude.com/cai/oauth/authorize?code=true&state=s",
      }),
    ]);
    rerender(view(waiting));
    expect(screen.getByRole("link", { name: "Open Anthropic sign-in ↗" })).toHaveAttribute(
      "href",
      CODE_URL,
    );
    expect(screen.getByRole("img", { name: "QR code of the sign-in link" })).toBeInTheDocument();
    const box = screen.getByLabelText("Paste the code, or the address your browser ended up on");
    expect(box).toHaveAttribute("type", "password");
    control.mockResolvedValueOnce({ ok: true, result: { acct: "team", signed_in: true } });
    fireEvent.change(box, { target: { value: "abcSECRET42" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    });
    expect(control).toHaveBeenCalledWith(
      "claude_signin_entry",
      { acct: "team", entry: "abcSECRET42" },
      expect.any(String),
      expect.any(Number),
    );
    expect(document.body.innerHTML).not.toContain("abcSECRET42");
    const done = reduceAll(waiting, [
      signinMsg("team", "claude_signin_done", { plan: "max", email: "team@example.com" }),
    ]);
    rerender(view(done));
    expect(screen.getByText(/Signed in as/)).toHaveTextContent("t•••@example.com");
  });

  it("Add → the Stepper shows the sign-in link from the event and completes on done", async () => {
    const { control, rerender, view, state } = setup();
    control.mockResolvedValueOnce({ ok: true, result: { acct: "team", account: "team" } });
    fireEvent.click(screen.getByRole("button", { name: "+ Add Claude account" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Account label" }), {
      target: { value: "Team" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Sign in on this machine" }));
    });
    expect(control).toHaveBeenCalledWith(
      "claude_account_add",
      { label: "Team", machine: "local" },
      expect.any(String),
      expect.any(Number),
    );
    expect(screen.getByText(/Starting the sign-in/)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Open Anthropic sign-in/ })).toBeNull();

    const waiting = reduceAll(state, [
      signinMsg("team", "claude_signin_url", { url: "https://example.com/oauth?code=abc" }),
    ]);
    rerender(view(waiting));
    const link = screen.getByRole("link", { name: /Open Anthropic sign-in/ });
    expect(link).toHaveAttribute("href", "https://example.com/oauth?code=abc");
    expect(link).toHaveAttribute("target", "_blank");

    const done = reduceAll(waiting, [signinMsg("team", "claude_signin_done", { plan: "max" })]);
    rerender(view(done));
    expect(screen.getByRole("heading", { name: "Added: Team" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryByRole("heading", { name: "Added: Team" })).toBeNull();
  });

  it("a failed sign-in says why", async () => {
    const { control, rerender, view, state } = setup();
    control.mockResolvedValueOnce({ ok: true, result: { acct: "team" } });
    fireEvent.click(screen.getByRole("button", { name: "+ Add Claude account" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Account label" }), {
      target: { value: "Team" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Sign in on this machine" }));
    });
    rerender(
      view(reduceAll(state, [signinMsg("team", "claude_signin_failed", { reason: "timed out" })])),
    );
    expect(screen.getByRole("alert")).toHaveTextContent("timed out");
  });

  it("Defaults shows the account for new waves and the warn-at threshold from config", async () => {
    const send = vi.fn(async () => ({ applied: true, rejected: [] }));
    setup([], { configTransport: { identity: "desk", send }, group: "defaults" });
    const group = screen.getByRole("radiogroup", { name: "Account for new waves" });
    expect(within(group).getByRole("radio", { name: "Most headroom" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(within(group).getByRole("radio", { name: "Work" })).toBeInTheDocument();
    expect(screen.getByText("85% of the 5-hour window")).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(within(group).getByRole("radio", { name: "Work" }));
    });
    expect(send).toHaveBeenCalledWith({ claude: { default_account: "work" } });
  });

  it("read-only without credentials: no add, no answers, the default as text", () => {
    const { rerender, view } = setup([], { control: null });
    expect(screen.getByRole("button", { name: "+ Add Claude account" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Move to Personal" })).toBeNull();
    rerender(view(undefined, { group: "defaults" }));
    expect(screen.queryByRole("radiogroup")).toBeNull();
    expect(screen.getByText("Most headroom")).toBeInTheDocument();
  });
});

describe("ClaudeAccounts review fixes", () => {
  it("Defaults shows a rejected config_set the way Supervisor's rows do", async () => {
    const send = vi.fn(async () => ({
      applied: false,
      rejected: [{ path: "claude.default_account", reason: "unknown account" }],
    }));
    setup([], { configTransport: { identity: "desk", send }, group: "defaults" });
    const group = screen.getByRole("radiogroup", { name: "Account for new waves" });
    await act(async () => {
      fireEvent.click(within(group).getByRole("radio", { name: "Work" }));
    });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "rejected · claude.default_account: unknown account",
    );
  });

  it("Defaults shows an unanswered config_set as no answer, and an applied one", async () => {
    const send = vi.fn(async () => ({
      applied: false,
      rejected: [],
      error: "volleyd did not answer",
      unanswered: true as const,
    }));
    setup([], { configTransport: { identity: "desk", send }, group: "defaults" });
    const group = screen.getByRole("radiogroup", { name: "Account for new waves" });
    await act(async () => {
      fireEvent.click(within(group).getByRole("radio", { name: "Work" }));
    });
    expect(screen.getByRole("alert")).toHaveTextContent("no answer");
    send.mockResolvedValueOnce({ applied: true, rejected: [], version: 4 } as never);
    await act(async () => {
      fireEvent.click(within(group).getByRole("radio", { name: "Personal" }));
    });
    expect(screen.getByText("applied · v4")).toBeInTheDocument();
  });

  it("the resets-in time keeps up with the clock while the section is open", () => {
    vi.useFakeTimers({ now: NOW, toFake: ["Date", "setInterval", "clearInterval"] });
    try {
      const state = reduceAll(initialState(), [accountMsg(work)]);
      const { container } = render(
        <ClaudeAccounts
          group="accounts"
          accounts={state.claudeAccounts ?? {}}
          signins={{}}
          config={config}
          control={null}
          configTransport={null}
        />,
      );
      const five = () =>
        within(within(container).getByRole("article", { name: "Work" }))
          .getByRole("meter", { name: "5-hour" })
          .closest(".meter");
      expect(five()).toHaveTextContent("resets in 4h 4m");
      act(() => {
        vi.advanceTimersByTime(60 * 60_000);
      });
      expect(five()).toHaveTextContent("resets in 3h 4m");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("ClaudeAccounts › this machine's own login (the primary)", () => {
  // volleyd's record for the primary, once `claude_accounts` has asked `claude auth status` (its
  // `describe("primary")`): the plan beside the windows.
  const primary: ClaudeAccountPayload = {
    account: "primary",
    plan: "max",
    five_hour: { pct: 34, resets_at: "2026-10-18T16:00:00.000Z" },
    weekly: { pct: 12, resets_at: null },
    agents: ["w1-t3-implementer-1"],
    waves: ["w1"],
    sampled_at: "2026-10-18T14:06:00.000Z",
  };
  /** volleyd's `claude_accounts` answer: the registry, the primary's plan (when known), sharing. */
  const registry = (rows: unknown[], primary: { plan?: string } = {}) =>
    vi.fn(async (op: string) =>
      op === "claude_accounts"
        ? {
            ok: true,
            result: {
              root: "/path/to/home/.volley/claude",
              accounts: rows,
              primary,
              sharing: { mcp: "copy" },
            },
          }
        : { ok: true },
    ) as unknown as ControlFn;

  it("shows a primary card from the start, before any usage, next to a newly added profile", async () => {
    render(
      <ClaudeAccounts
        group="accounts"
        accounts={{}}
        signins={{}}
        config={config}
        control={registry([{ id: "team", label: "Team", machine: "local", signed_in_at: SIGNED }])}
        configTransport={null}
        now={NOW}
      />,
    );
    await screen.findByRole("article", { name: "Team" });
    const cards = screen.getAllByRole("article");
    expect(cards.map((c) => c.getAttribute("aria-label"))).toEqual([
      "This machine's Claude login",
      "Team",
    ]);
    const p = within(cards[0] as HTMLElement);
    expect(p.getByText(/^primary · /)).toHaveTextContent("primary · Claude Code's default login");
    expect(p.queryByText((_, el) => el?.classList.contains("chip") === true)).toBeNull();
    // volleyd is asked to read it (claude_prime): no usage until it answers
    for (const name of ["5-hour", "7-day"]) {
      const m = p.getByRole("meter", { name });
      await waitFor(() => expect(m).toHaveAttribute("aria-valuetext", "no reading yet"));
      expect(m.closest(".meter")).toHaveTextContent("no reading yet");
    }
  });

  it("before any usage, the primary card shows the plan claude_accounts reports for it", async () => {
    render(
      <ClaudeAccounts
        group="accounts"
        accounts={{}}
        signins={{}}
        config={config}
        control={registry([], { plan: "max" })}
        configTransport={null}
        now={NOW}
      />,
    );
    const card = screen.getByRole("article", { name: "This machine's Claude login" });
    expect(await within(card).findByText("max")).toHaveClass("chip");
    await waitFor(() =>
      expect(within(card).getByRole("meter", { name: "5-hour" })).toHaveAttribute(
        "aria-valuetext",
        "no reading yet",
      ),
    );
  });

  it("a primary whose plan volleyd does not know shows none, never a guess", async () => {
    const control = registry([
      { id: "team", label: "Team", machine: "local", plan: "pro", signed_in_at: SIGNED },
    ]);
    render(
      <ClaudeAccounts
        group="accounts"
        accounts={{}}
        signins={{}}
        config={config}
        control={control}
        configTransport={null}
        now={NOW}
      />,
    );
    await screen.findByRole("article", { name: "Team" });
    const card = screen.getByRole("article", { name: "This machine's Claude login" });
    expect(within(card).queryByText((_, el) => el?.classList.contains("chip") === true)).toBeNull();
  });

  it("read-only, with nothing reported, still shows the primary card", () => {
    render(
      <ClaudeAccounts
        group="accounts"
        accounts={{}}
        signins={{}}
        config={config}
        control={null}
        configTransport={null}
        now={NOW}
      />,
    );
    expect(screen.getByRole("article", { name: "This machine's Claude login" })).toBeVisible();
  });

  it("the primary's usage record fills the same card, first, with its plan", () => {
    const state = reduceAll(initialState(), [accountMsg(work), accountMsg(primary)]);
    render(
      <ClaudeAccounts
        group="accounts"
        accounts={state.claudeAccounts ?? {}}
        signins={{}}
        config={config}
        control={null}
        configTransport={null}
        now={NOW}
      />,
    );
    const cards = screen.getAllByRole("article");
    expect(cards.map((c) => c.getAttribute("aria-label"))).toEqual([
      "This machine's Claude login",
      "Work",
    ]);
    const p = within(cards[0] as HTMLElement);
    expect(p.getByText("max")).toHaveClass("chip");
    expect(p.getByRole("meter", { name: "5-hour" })).toHaveAttribute("aria-valuenow", "34");
  });

  it("another machine's primary is that machine's card, not this one's", () => {
    const state = reduceAll(initialState(), [accountMsg({ ...primary, account: "primary@box" })]);
    render(
      <ClaudeAccounts
        group="accounts"
        accounts={state.claudeAccounts ?? {}}
        signins={{}}
        config={config}
        control={null}
        configTransport={null}
        now={NOW}
      />,
    );
    expect(screen.getAllByRole("article").map((c) => c.getAttribute("aria-label"))).toEqual([
      "This machine's Claude login",
      "primary@box",
    ]);
  });

  it("Defaults still names the primary plainly", () => {
    const send = vi.fn(async () => ({ applied: true, rejected: [] }));
    setup([], { configTransport: { identity: "desk", send }, group: "defaults" });
    const group = screen.getByRole("radiogroup", { name: "Account for new waves" });
    expect(within(group).getByRole("radio", { name: "Primary" })).toBeInTheDocument();
  });
});

describe("ClaudeAccounts › one card per Anthropic account", () => {
  const EMAIL = "owner@example.com";
  const own: ClaudeAccountPayload = {
    ...work,
    email: EMAIL,
    org: "Example Org",
    five_hour: { pct: 37, resets_at: "2026-10-18T18:10:00.000Z" },
    weekly: { pct: 56, resets_at: "2026-10-21T09:00:00.000Z" },
  };
  const peer: ClaudeAccountPayload = {
    account: "primary@peer-a",
    five_hour: { pct: 41, resets_at: null },
    weekly: { pct: 56, resets_at: "2026-10-21T09:00:00.000Z" },
    agents: ["w2-t1-implementer-1"],
    waves: ["w2"],
    sampled_at: "2026-10-18T11:06:00.000Z",
  };
  const machines = {
    "peer-a": {
      name: "peer-a",
      kind: "peer",
      os: "linux",
      cores: 8,
      tunnel: "up",
      load: [0, 0, 0],
      agents: 1,
      last_seen: "2026-10-18T14:06:00.000Z",
      auth: { gh: "ok", claude: "signed_in", trust: "ok", claude_email: EMAIL },
    },
  } as unknown as NonNullable<ClaudeAccountsProps["machines"]>;

  const view = (records: Record<string, ClaudeAccountPayload>) => (
    <main>
      <ClaudeAccounts
        accounts={records}
        signins={{}}
        config={config}
        control={null}
        configTransport={null}
        machines={machines}
        localName="hub"
        group="accounts"
        now={NOW}
      />
    </main>
  );
  const card = () => screen.getByRole("article", { name: "Work" });

  it("renders one masked card for two logins on one e-mail", () => {
    const { container } = render(view({ work: own, "primary@peer-a": peer }));
    expect(screen.getAllByRole("article").map((c) => c.getAttribute("aria-label"))).toEqual([
      "This machine's Claude login",
      "Work",
    ]);
    expect(within(card()).getByText("o•••@example.com")).toBeInTheDocument();
    expect(within(card()).getByText("Example Org")).toBeInTheDocument();
    expect(container.innerHTML).not.toContain(EMAIL);
  });

  it("the eye button reveals and hides the address, and nothing is persisted", () => {
    const { unmount } = render(view({ work: own, "primary@peer-a": peer }));
    const c = within(card());
    const eye = c.getByRole("button", { name: "Show email" });
    expect(eye).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(eye);
    expect(eye).toHaveAttribute("aria-pressed", "true");
    expect(eye).toHaveAccessibleName("Hide email");
    expect(c.getByText(EMAIL)).toBeInTheDocument();
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
    fireEvent.click(eye);
    expect(eye).toHaveAttribute("aria-pressed", "false");
    expect(c.queryByText(EMAIL)).toBeNull();
    fireEvent.click(eye);
    unmount();
    render(view({ work: own, "primary@peer-a": peer }));
    expect(within(card()).getByRole("button", { name: "Show email" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(within(card()).queryByText(EMAIL)).toBeNull();
  });

  it("lists each machine holding the account with its sign-in state only", () => {
    render(view({ work: own, "primary@peer-a": peer }));
    const rows = within(within(card()).getByRole("list", { name: "Machines" })).getAllByRole(
      "listitem",
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("this machine");
    expect(rows[0]).toHaveTextContent("Work");
    expect(rows[0]).toHaveTextContent("signed in");
    expect(rows[1]).toHaveTextContent("peer-a");
    expect(rows[1]).toHaveTextContent("default login");
    expect(rows[1]).toHaveTextContent("signed in");
    for (const r of rows) expect(r.textContent).not.toMatch(/waves|%/);
  });

  it("the meters show the freshest reading, and nothing is called stale", () => {
    render(view({ work: own, "primary@peer-a": peer }));
    const c = within(card());
    expect(c.getByRole("meter", { name: "5-hour" })).toHaveAttribute("aria-valuenow", "37");
    expect(card()).not.toHaveTextContent(/stale|freshest/);
    expect(c.getByText("Last updated: just now")).toBeInTheDocument();
  });

  describe("three meters: 5-hour, 7-day and Fable", () => {
    const min = (n: number) => new Date(NOW - n * 60_000).toISOString();
    const fable = { pct: 12, resets_at: "2026-10-22T16:00:00.000Z" };
    const read = (
      probe: NonNullable<ClaudeAccountPayload["probe"]>,
      w: typeof fable | null = fable,
    ): ClaudeAccountPayload => ({ ...peer, ...(w ? { model_weekly: { fable: w } } : {}), probe });
    const fableMeter = () => within(card()).getByRole("meter", { name: "Fable (7-day)" });

    it("labels the three meters and reads the Fable figure with its age and machine", () => {
      render(
        view({
          work: own,
          "primary@peer-a": read({
            machine: "peer-a",
            state: "ok",
            attempted_at: min(4),
            read_at: min(4),
          }),
        }),
      );
      const c = within(card());
      expect(c.getAllByRole("meter").map((m) => m.getAttribute("aria-label"))).toEqual([
        "5-hour",
        "7-day",
        "Fable (7-day)",
      ]);
      expect(fableMeter()).toHaveAttribute("aria-valuetext", "12%, read 4 min ago on peer-a");
      expect(fableMeter().closest(".meter")).toHaveTextContent(
        "resets in 4d 1h · read 4 min ago on peer-a",
      );
    });

    it("before any probe: —, not read yet", () => {
      render(view({ work: own, "primary@peer-a": peer }));
      expect(fableMeter()).toHaveAttribute("aria-valuetext", "not read yet");
      expect(fableMeter().closest(".meter")).toHaveTextContent("—");
      expect(fableMeter().closest(".meter")).toHaveTextContent("not read yet");
    });

    it("an expired login reads — with its hint and the last read's age", () => {
      render(
        view({
          work: own,
          "primary@peer-a": read({
            machine: "peer-a",
            state: "expired",
            attempted_at: min(1),
            read_at: min(25),
          }),
        }),
      );
      expect(fableMeter()).toHaveAttribute(
        "aria-valuetext",
        "login expired — Claude Code renews it on its next request; last read 25 min ago",
      );
      expect(fableMeter().closest(".meter")?.querySelector(".meter-pct")).toHaveTextContent("—");
    });

    it("no machine row shows a figure or its own age: the meters appear once", () => {
      render(
        view({
          work: own,
          "primary@peer-a": read({
            machine: "peer-a",
            state: "ok",
            attempted_at: min(4),
            read_at: min(4),
          }),
        }),
      );
      const rows = within(within(card()).getByRole("list", { name: "Machines" })).getAllByRole(
        "listitem",
      );
      for (const r of rows) expect(r.textContent).not.toMatch(/%|5h|7d|Fable|sampled/);
      expect(within(card()).getAllByRole("meter")).toHaveLength(3);
    });

    it("a window whose reset passed shows 0 %", () => {
      const passed = { ...own, five_hour: { pct: 37, resets_at: min(5) } };
      render(view({ work: passed, "primary@peer-a": peer }));
      expect(within(card()).getByRole("meter", { name: "5-hour" })).toHaveAttribute(
        "aria-valuenow",
        "0",
      );
    });

    it("passes axe with the three meters and the machine rows", async () => {
      render(
        view({
          work: own,
          "primary@peer-a": read({
            machine: "peer-a",
            state: "rate_limited",
            attempted_at: min(1),
            read_at: min(25),
          }),
        }),
      );
      const v = await axe.run(document.body, { rules: { "color-contrast": { enabled: false } } });
      expect(v.violations.map((x) => x.id)).toEqual([]);
    });
  });

  it("a card with no e-mail says so, never a command, and has no eye button", () => {
    render(view({ work: own, "primary@box": { ...peer, account: "primary@box" } }));
    const c = within(screen.getByRole("article", { name: "primary@box" }));
    // read-only: nothing can ask volleyd for it
    expect(
      c.getByText("no reading yet", { selector: ".s-hint:not(.cc-updated)" }),
    ).toBeInTheDocument();
    expect(c.queryByText(/doctor/i)).toBeNull();
    expect(c.queryByRole("button", { name: /email/ })).toBeNull();
  });

  it("passes axe with the address hidden and shown", async () => {
    render(view({ work: own, "primary@peer-a": peer }));
    const run = async () =>
      (
        await axe.run(document.body, { rules: { "color-contrast": { enabled: false } } })
      ).violations.map((v) => v.id);
    expect(await run()).toEqual([]);
    fireEvent.click(within(card()).getByRole("button", { name: "Show email" }));
    expect(await run()).toEqual([]);
  });
});

describe("ClaudeAccounts › Add on any machine", () => {
  const MANUAL = "https://claude.com/cai/oauth/authorize?code=true&state=m";
  const URL = "https://claude.com/cai/oauth/authorize?redirect_uri=localhost&state=s";
  const ATTACH = "ssh dev@peer-a -t tmux attach -t volley-signin-work";
  const machines = {
    "peer-a": { name: "peer-a", kind: "peer", tunnel: "up", auth: { claude: "signed_out" } },
    "peer-b": { name: "peer-b", kind: "peer", tunnel: "down", auth: { claude: "signed_out" } },
  } as unknown as NonNullable<ClaudeAccountsProps["machines"]>;
  const fleet = { hosts: ["peer-a", "peer-b"], machines, localName: "hub" };
  const radio = (name: RegExp) => screen.getByRole("radio", { name });

  it("step 1 lists this machine and each paired host; a peer whose tunnel is down is disabled", () => {
    setup([], fleet);
    fireEvent.click(screen.getByRole("button", { name: "+ Add Claude account" }));
    const picker = within(screen.getByRole("group", { name: "Machine" }));
    expect(picker.getAllByRole("radio").map((r) => r.closest("label")?.textContent)).toEqual([
      "this machine",
      "peer-a",
      "peer-btunnel down",
    ]);
    expect(radio(/^this machine/)).toBeChecked();
    expect(radio(/^peer-a/)).toBeEnabled();
    expect(radio(/^peer-b/)).toBeDisabled();
    expect(screen.queryByText(/volley claude add/)).toBeNull();
  });

  it("a peer's sign-in shows the code-page link, the one box and the terminal fallback, and completes there", async () => {
    const { control, rerender, view, state } = setup([], fleet);
    control.mockResolvedValueOnce({
      ok: true,
      result: {
        acct: "work@peer-a",
        url: MANUAL,
        flow: "manual_code",
        attach: ATTACH,
        manual_url: MANUAL,
        callback_url: URL,
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "+ Add Claude account" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Account label" }), {
      target: { value: "Work" },
    });
    fireEvent.click(radio(/^peer-a/));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Sign in on peer-a" }));
    });
    expect(control).toHaveBeenCalledWith(
      "claude_account_add",
      { label: "Work", machine: "peer-a" },
      expect.any(String),
      expect.any(Number),
    );
    expect(screen.getByRole("link", { name: "Open Anthropic sign-in ↗" })).toHaveAttribute(
      "href",
      MANUAL,
    );
    expect(
      screen.getByLabelText("Paste the code, or the address your browser ended up on"),
    ).toHaveAttribute("type", "password");
    expect(screen.getByRole("link", { name: /Open here instead/ })).toHaveAttribute("href", URL);
    fireEvent.click(screen.getByText("Terminal instead"));
    expect(document.body).toHaveTextContent(ATTACH);

    const done = reduceAll(state, [
      signinMsg("work@peer-a", "claude_signin_url", { url: URL, flow: "browser_callback" }),
      signinMsg("work@peer-a", "claude_signin_done", { plan: "max" }),
    ]);
    rerender(view(done));
    expect(screen.getByRole("heading", { name: "Added: Work" })).toBeInTheDocument();
    expect(screen.getByText(/max · signed in on peer-a/)).toBeInTheDocument();
  });

  it("Add to another machine… prefills the label and greys out the machines holding it", () => {
    setup([], fleet);
    const card = within(screen.getByRole("article", { name: "Work" }));
    fireEvent.click(card.getByRole("button", { name: "Add to another machine…" }));
    // volleyd's ids are unique across machines, so the prefill names the machine too.
    expect(screen.getByRole("textbox", { name: "Account label" })).toHaveValue("Work (peer-a)");
    expect(screen.getByText(/needs its own label/)).toBeInTheDocument();
    expect(radio(/^this machine/)).toBeDisabled();
    expect(radio(/^this machine/).closest("label")).toHaveTextContent("already holds this account");
    expect(radio(/^peer-a/)).toBeEnabled();
    expect(radio(/^peer-a/)).toBeChecked();
    expect(screen.getByRole("button", { name: "Sign in on peer-a" })).toBeEnabled();
  });

  it("Add to another machine… sends the label volleyd accepts, and keeps one the owner typed", async () => {
    const { control } = setup([], {
      ...fleet,
      machines: {
        ...machines,
        "peer-b": { ...machines["peer-a"], name: "peer-b" },
      } as typeof machines,
    });
    control.mockResolvedValue({ ok: false });
    const card = within(screen.getByRole("article", { name: "Work" }));
    fireEvent.click(card.getByRole("button", { name: "Add to another machine…" }));
    const field = screen.getByRole("textbox", { name: "Account label" });
    fireEvent.click(radio(/^peer-b/));
    expect(field).toHaveValue("Work (peer-b)");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Sign in on peer-b" }));
    });
    expect(control).toHaveBeenLastCalledWith(
      "claude_account_add",
      { label: "Work (peer-b)", machine: "peer-b" },
      expect.any(String),
      expect.any(Number),
    );
    fireEvent.change(field, { target: { value: "Office" } });
    fireEvent.click(radio(/^peer-a/));
    expect(field).toHaveValue("Office");
  });

  it("Add to another machine… on the primary's card starts with an empty label", () => {
    setup([], fleet);
    const card = within(screen.getByRole("article", { name: "This machine's Claude login" }));
    fireEvent.click(card.getByRole("button", { name: "Add to another machine…" }));
    expect(screen.getByRole("textbox", { name: "Account label" })).toHaveValue("");
    expect(screen.getByRole("button", { name: "Sign in on peer-a" })).toBeDisabled();
  });

  it("Add to another machine… on a peer's card names this machine by its host name", () => {
    const team: ClaudeAccountPayload = { ...personal, account: "team@peer-a", label: "Team" };
    setup([accountMsg(team)], fleet);
    const card = within(screen.getByRole("article", { name: "Team" }));
    fireEvent.click(card.getByRole("button", { name: "Add to another machine…" }));
    expect(radio(/^this machine/)).toBeChecked();
    expect(screen.getByRole("textbox", { name: "Account label" })).toHaveValue("Team (hub)");
  });

  it("a peer's sign-in waits for the link, and says why when it fails", async () => {
    const { control, rerender, view, state } = setup([], fleet);
    control.mockResolvedValueOnce({ ok: true, result: { acct: "work@peer-a" } });
    fireEvent.click(screen.getByRole("button", { name: "+ Add Claude account" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Account label" }), {
      target: { value: "Work" },
    });
    fireEvent.click(radio(/^peer-a/));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Sign in on peer-a" }));
    });
    expect(screen.getByText(/Starting the sign-in on peer-a…/)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Open Anthropic sign-in/ })).toBeNull();

    rerender(
      view(
        reduceAll(state, [
          signinMsg("work@peer-a", "claude_signin_url", { url: URL, flow: "browser_callback" }),
          signinMsg("work@peer-a", "claude_signin_failed", { reason: "timed out" }),
        ]),
      ),
    );
    expect(screen.getByRole("alert")).toHaveTextContent("The sign-in did not finish: timed out");
    expect(screen.queryByRole("link", { name: /Open Anthropic sign-in/ })).toBeNull();
  });

  it("a paired host with no machine record yet is offered, and says so", () => {
    setup([], { ...fleet, hosts: ["peer-a", "peer-c"] });
    fireEvent.click(screen.getByRole("button", { name: "+ Add Claude account" }));
    expect(radio(/^peer-c/)).toBeEnabled();
    expect(radio(/^peer-c/).closest("label")).toHaveTextContent("no record yet");
  });

  it("read-only: no Add to another machine…", () => {
    setup([], { ...fleet, control: null });
    expect(screen.queryByRole("button", { name: "Add to another machine…" })).toBeNull();
  });

  it("the radios are reachable from the keyboard and Cancel closes the dialog", () => {
    setup([], fleet);
    fireEvent.click(screen.getByRole("button", { name: "+ Add Claude account" }));
    const here = radio(/^this machine/);
    here.focus();
    expect(here).toHaveFocus();
    expect(here).not.toHaveAttribute("tabindex", "-1");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("group", { name: "Machine" })).toBeNull();
  });
});

describe("ClaudeAccounts › the per-machine account matrix", () => {
  const EMAIL = "owner@example.com";
  const URL = "https://claude.com/cai/oauth/authorize?redirect_uri=localhost&state=s";
  const own: ClaudeAccountPayload = { ...work, email: EMAIL };
  const peerMachine = (name: string, over: Record<string, unknown> = {}) => ({
    name,
    kind: "peer",
    tunnel: "up",
    auth: { claude: "signed_out" },
    ...over,
  });
  const machines = {
    "peer-a": peerMachine("peer-a", { auth: { claude: "signed_in", claude_email: EMAIL } }),
    "peer-b": peerMachine("peer-b"),
  } as unknown as NonNullable<ClaudeAccountsProps["machines"]>;
  const fleet = { hosts: ["peer-a", "peer-b"], machines, localName: "hub" };

  function matrix(props: Partial<ClaudeAccountsProps> = {}) {
    const state = reduceAll(initialState(), [accountMsg(own)]);
    const control = vi.fn(async (op: string) =>
      op === "claude_account_add"
        ? { ok: true, result: { acct: "work-peer-b@peer-b", url: URL, flow: "browser_callback" } }
        : ({ ok: true } as { ok: boolean; result?: unknown }),
    );
    const view = (s = state) => (
      <main>
        <ClaudeAccounts
          accounts={s.claudeAccounts ?? {}}
          signins={s.signins ?? {}}
          config={config}
          control={control}
          configTransport={null}
          now={NOW}
          group="accounts"
          {...fleet}
          {...props}
        />
      </main>
    );
    const r = render(view());
    return { ...r, state, control, view };
  }
  const card = () => within(screen.getByRole("article", { name: "Work" }));
  const rows = () =>
    within(card().getByRole("list", { name: "Machines" })).getAllByRole("listitem");
  const signInOn = async (machine: string) => {
    await act(async () => {
      fireEvent.click(card().getByRole("button", { name: `Sign in on ${machine} with Work` }));
    });
  };

  it("one row per configured machine; the one missing it offers Sign in on it", () => {
    matrix();
    expect(rows().map((r) => r.querySelector("b")?.textContent)).toEqual([
      "this machine",
      "peer-a",
      "peer-b",
    ]);
    expect(rows()[0]).toHaveTextContent("signed in");
    expect(rows()[2]).toHaveTextContent("not on peer-b");
    const button = within(rows()[2] as HTMLElement).getByRole("button");
    expect(button).toHaveAccessibleName("Sign in on peer-b with Work");
    expect(button).toHaveTextContent("Sign in on peer-b");
    expect(rows()[2]?.querySelector(".cc-dot--in")).toBeNull();
    expect(screen.getByRole("article", { name: "Work" })).not.toHaveTextContent(
      /on \d of \d machines/,
    );
  });

  it("an account on every configured machine offers no Sign in", () => {
    matrix({ hosts: ["peer-a"] });
    expect(card().queryByRole("button", { name: /^Sign in on/ })).toBeNull();
  });

  it("Sign in on peer-b opens Add at the sign-in step, signing in with the masked account", async () => {
    const { control } = matrix();
    await signInOn("peer-b");
    expect(control).toHaveBeenCalledWith(
      "claude_account_add",
      { label: "Work (peer-b)", machine: "peer-b" },
      expect.any(String),
      expect.any(Number),
    );
    expect(screen.queryAllByRole("textbox")).toHaveLength(0);
    expect(screen.queryByRole("group", { name: "Machine" })).toBeNull();
    const dialog = within(screen.getByRole("region", { name: "Add Claude account" }));
    expect(dialog.getByRole("heading", { level: 3 })).toHaveTextContent(
      "Sign in with o•••@example.com on peer-b",
    );
    expect(dialog.getByRole("link", { name: /Open Anthropic sign-in/ })).toHaveAttribute(
      "href",
      URL,
    );
    expect(
      dialog.getByLabelText("Paste the code, or the address your browser ended up on"),
    ).toBeInTheDocument();
    fireEvent.click(dialog.getByRole("button", { name: "Show email" }));
    expect(dialog.getByRole("heading", { level: 3 })).toHaveTextContent(
      `Sign in with ${EMAIL} on peer-b`,
    );
    fireEvent.click(dialog.getByRole("button", { name: "Hide email" }));
    expect(dialog.getByRole("heading", { level: 3 })).not.toHaveTextContent(EMAIL);
  });

  it("sends the sign-in once, even when the dialog re-renders", async () => {
    const { control, rerender, view } = matrix();
    await signInOn("peer-b");
    rerender(view());
    await act(flushAll);
    expect(control.mock.calls.filter(([op]) => op === "claude_account_add")).toHaveLength(1);
  });

  it("a sign-in done on the same e-mail fills the row", async () => {
    const { rerender, view, state } = matrix();
    await signInOn("peer-b");
    rerender(
      view(
        reduceAll(state, [
          signinMsg("work-peer-b@peer-b", "claude_signin_done", { plan: "max", email: EMAIL }),
        ]),
      ),
    );
    expect(rows()[2]).toHaveTextContent("peer-b");
    expect(rows()[2]).toHaveTextContent("Work (peer-b)");
    expect(rows()[2]?.querySelector(".cc-dot--in")).not.toBeNull();
    expect(rows()[2]).toHaveTextContent("signed in");
  });

  it("a sign-in done on another e-mail leaves the row empty and says so", async () => {
    const { rerender, view, state } = matrix();
    await signInOn("peer-b");
    rerender(
      view(
        reduceAll(state, [
          signinMsg("work-peer-b@peer-b", "claude_signin_done", { email: "p@example.com" }),
        ]),
      ),
    );
    expect(rows()[2]).toHaveTextContent("signed in as another account (p•••@example.com)");
    expect(screen.getByRole("status")).toHaveTextContent(
      "That was another account (p•••@example.com): it gets a card of its own, and peer-b still misses o•••@example.com.",
    );
    expect(rows()[2]?.querySelector(".cc-dot--in")).toBeNull();
  });

  it("a machine whose tunnel is down: the button is disabled, and says why", () => {
    matrix({
      machines: { ...machines, "peer-b": peerMachine("peer-b", { tunnel: "down" }) } as never,
    });
    expect(card().getByRole("button", { name: "Sign in on peer-b with Work" })).toBeDisabled();
    expect(rows()[2]).toHaveTextContent("tunnel down");
  });

  it("read-only: the row says the machine misses it, with no button", () => {
    matrix({ control: null });
    expect(rows()[2]).toHaveTextContent("not on peer-b");
    expect(card().queryByRole("button", { name: /^Sign in on/ })).toBeNull();
  });

  it("passes axe with a gap row, and with the sign-in dialog open", async () => {
    matrix();
    const run = async () =>
      (
        await axe.run(document.body, { rules: { "color-contrast": { enabled: false } } })
      ).violations.map((v) => v.id);
    expect(await run()).toEqual([]);
    await signInOn("peer-b");
    expect(await run()).toEqual([]);
  });
});

describe("reducer: a finished sign-in's e-mail", () => {
  it("keeps the login's e-mail from claude_signin_done", () => {
    const s = reduceAll(initialState(), [
      signinMsg("team", "claude_signin_done", { plan: "max", email: "owner@example.com" }),
    ]);
    expect(s.signins?.team).toMatchObject({ state: "done", email: "owner@example.com" });
  });
});

const flushAll = () => new Promise((r) => setTimeout(r, 0));

describe("Sign in on <machine>: the preset's label and the finished sign-in", () => {
  const group = (over: Partial<AccountGroup>): AccountGroup => ({
    key: "owner@example.com",
    email: "owner@example.com",
    org: null,
    label: "Work",
    plan: "max",
    fiveHour: null,
    weekly: null,
    fable: null,
    probe: null,
    freshest: null,
    members: [],
    agents: [],
    waves: [],
    ...over,
  });
  const member = (label: string, machine: string) => ({
    account: label.toLowerCase(),
    machine,
    label,
    signedIn: true,
    agents: [],
    waves: [],
    isPrimary: false,
    sampledAt: null,
  });
  const peerB = { name: "peer-b", op: "peer-b", up: true };

  it("a label already naming its machine is not suffixed twice", () => {
    const g = group({ members: [member("Work (peer-a)", "peer-a")] });
    expect(signInPreset(g, peerB).label).toBe("Work (peer-b)");
    expect(signInPreset(group({ members: [member("Work", "local")] }), peerB).label).toBe(
      "Work (peer-b)",
    );
  });

  it("a group with no reported e-mail takes the login it started as its own", () => {
    const g = group({ key: "work", email: null, members: [member("Work", "local")] });
    const { groups, others } = withSignIns(
      [g],
      [{ key: "work", op: "peer-b", label: "Work (peer-b)", acct: "work-peer-b@peer-b" }],
      { "work-peer-b@peer-b": { state: "done", email: "owner@example.com" } as never },
    );
    expect(others).toEqual({});
    expect(groups[0]?.members.map((m) => m.machine)).toEqual(["local", "peer-b"]);
  });
});

describe("ClaudeAccounts › the balance and the agent-level decision (T8)", () => {
  const EMAIL = "owner@example.com";
  const machines = {
    "peer-a": {
      name: "peer-a",
      kind: "peer",
      tunnel: "up",
      auth: { claude: "signed_in", claude_email: EMAIL },
    },
  } as unknown as NonNullable<ClaudeAccountsProps["machines"]>;
  const balance = {
    machines: [
      {
        name: "local",
        candidates: [],
        picks: { fable: "personal", opus: "personal", sonnet: "personal", haiku: "personal" },
      },
      {
        name: "peer-a",
        candidates: [],
        picks: { fable: "primary@peer-a", opus: "primary@peer-a" },
      },
    ],
  };

  function view(control: ControlFn | null) {
    const state = reduceAll(initialState(), [
      accountMsg({ ...work, email: EMAIL }),
      accountMsg(personal),
    ]);
    return render(
      <main>
        <ClaudeAccounts
          accounts={state.claudeAccounts ?? {}}
          signins={{}}
          config={config}
          control={control}
          configTransport={null}
          now={NOW}
          group="accounts"
          machines={machines}
          localName="hub"
          hosts={["peer-a"]}
        />
      </main>,
    );
  }
  const answering = () =>
    vi.fn(async (op: string) =>
      op === "claude_balance"
        ? { ok: true, result: balance }
        : ({ ok: true } as { ok: boolean; result?: unknown }),
    );

  it("the card asks no claude_balance and says nothing of next picks", () => {
    const control = answering();
    view(control);
    expect(control).not.toHaveBeenCalledWith(
      "claude_balance",
      expect.anything(),
      expect.anything(),
    );
    expect(screen.queryByText(/picks next/)).toBeNull();
    expect(screen.queryByText("next pick")).toBeNull();
  });
});

describe("ClaudeAccounts › one clean card per account (#496)", () => {
  const EMAIL = "owner@example.com";
  const PENDING_URL = "https://claude.com/cai/oauth/authorize?state=p";
  const at = (min: number) => new Date(NOW - min * 60_000).toISOString();
  const own: ClaudeAccountPayload = { ...work, email: EMAIL, sampled_at: at(4) };
  const machines = {
    "box-a": {
      name: "box-a",
      kind: "peer",
      tunnel: "up",
      auth: { claude: "signed_out" },
    },
  } as unknown as NonNullable<ClaudeAccountsProps["machines"]>;
  const answering = (rows: unknown[] = []) =>
    vi.fn(async (op: string) =>
      op === "claude_accounts"
        ? { ok: true, result: { accounts: rows, primary: {} } }
        : op === "claude_signin"
          ? { ok: true, result: { acct: "pending-work@box-a", url: PENDING_URL } }
          : ({ ok: true } as { ok: boolean; result?: unknown }),
    );
  const view = (
    records: Record<string, ClaudeAccountPayload>,
    control: ControlFn | null = answering() as unknown as ControlFn,
  ) =>
    render(
      <main>
        <ClaudeAccounts
          accounts={records}
          signins={{}}
          config={config}
          control={control}
          configTransport={null}
          machines={machines}
          localName="hub"
          hosts={["box-a"]}
          group="accounts"
          now={NOW}
        />
      </main>,
    );
  const card = () => screen.getByRole("article", { name: "Work" });

  it("renders the name, e-mail, plan, three meters, the machines, the actions and the footer", () => {
    view({ work: own });
    const c = within(card());
    expect(c.getByText("Work", { selector: "b" })).toBeInTheDocument();
    expect(c.getByText("o•••@example.com")).toBeInTheDocument();
    expect(c.getByRole("button", { name: "Show email" })).toBeInTheDocument();
    expect(c.getByText("max")).toHaveClass("chip");
    expect(c.getAllByRole("meter")).toHaveLength(3);
    const rows = within(c.getByRole("list", { name: "Machines" })).getAllByRole("listitem");
    expect(rows.map((r) => r.querySelector("b")?.textContent)).toEqual(["this machine", "box-a"]);
    expect(rows[0]).toHaveTextContent("signed in");
    expect(rows[1]).toHaveTextContent("not on box-a");
    expect(card().querySelector(".cc-machines")?.textContent).not.toContain("%");
    expect(c.getByRole("button", { name: "Add to another machine…" })).toBeEnabled();
    expect(c.getByRole("button", { name: "Rename Work" })).toBeEnabled();
    expect(c.getByRole("button", { name: "Remove Work…" })).toBeEnabled();
    expect(c.getByText("Last updated: 4 min ago")).toHaveClass("cc-updated");
    for (const gone of [
      /waves/,
      /agent/,
      /Use for/,
      /next pick/,
      /picks next/,
      /stale/,
      /freshest:/,
    ])
      expect(card().textContent).not.toMatch(gone);
    expect(c.queryByRole("combobox")).toBeNull();
  });

  it("never counts agents: 29 historical agents on the record show nowhere on the card", () => {
    const agents = Array.from({ length: 29 }, (_, i) => `w1-t${i}-implementer-1`);
    view({ work: { ...own, agents } }, null);
    expect(card().textContent).not.toMatch(/29|agent/);
  });

  it("a 0% window with no reset reads no usage yet this window; 12% reset time unknown", () => {
    view({
      work: {
        ...own,
        five_hour: { pct: 0, resets_at: null },
        weekly: { pct: 12, resets_at: null },
      },
    });
    const meter = (name: string) =>
      within(card()).getByRole("meter", { name }).closest(".meter") as HTMLElement;
    expect(meter("5-hour")).toHaveTextContent("no usage yet this window");
    expect(meter("7-day")).toHaveTextContent("reset time unknown");
  });

  it("a profile waiting for sign-in is a row with Finish sign-in, never a card", async () => {
    const pending = {
      id: "pending-work",
      label: "Work (box-a)",
      machine: "box-a",
      signin: { state: "pending", url: PENDING_URL },
    };
    const control = answering([pending]);
    view({ work: own }, control as unknown as ControlFn);
    const section = within(
      await screen.findByRole("region", { name: "Profiles waiting for sign-in" }),
    );
    expect(section.getByText("Work (box-a)")).toBeInTheDocument();
    expect(section.getByRole("button", { name: "Cancel Work (box-a)" })).toBeEnabled();
    expect(screen.queryByRole("article", { name: "Work (box-a)" })).toBeNull();
    expect(screen.getAllByRole("article").map((a) => a.getAttribute("aria-label"))).toEqual([
      "This machine's Claude login",
      "Work",
    ]);
    expect(
      screen.queryByRole("button", { name: /^Sign in on box-a with Work \(box-a\)/ }),
    ).toBeNull();
    await act(async () => {
      fireEvent.click(section.getByRole("button", { name: "Finish sign-in for Work (box-a)" }));
    });
    expect(control).toHaveBeenCalledWith(
      "claude_signin",
      { acct: "pending-work@box-a" },
      expect.any(String),
      expect.any(Number),
    );
    expect(control).not.toHaveBeenCalledWith(
      "claude_account_add",
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
    const dialog = within(screen.getByRole("region", { name: "Add Claude account" }));
    expect(dialog.getByRole("heading", { level: 3 })).toHaveTextContent(
      "Sign in as Work (box-a) on box-a",
    );
  });

  it("passes axe with the card and the pending section", async () => {
    view(
      { work: own },
      answering([{ id: "p", label: "P", machine: "box-a", signin: { state: "pending" } }]) as never,
    );
    await screen.findByRole("region", { name: "Profiles waiting for sign-in" });
    const v = await axe.run(document.body, { rules: { "color-contrast": { enabled: false } } });
    expect(v.violations.map((x) => x.id)).toEqual([]);
  });
});

describe("ClaudeAccounts › rename, remove and the live registry (#497)", () => {
  const EMAIL = "owner@example.com";
  const own: ClaudeAccountPayload = { ...work, email: EMAIL };
  const row = (id: string, machine: string, label = "Work") => ({
    id,
    label,
    machine,
    email: EMAIL,
    plan: "max",
    signed_in_at: SIGNED,
    signin: { state: "signed_in" },
  });
  const machines = {
    "box-a": { name: "box-a", kind: "peer", tunnel: "up", auth: { claude: "signed_out" } },
  } as unknown as NonNullable<ClaudeAccountsProps["machines"]>;
  /** A volleyd whose registry the test edits; rename and remove answer as `answers` says. */
  function volleyd(
    rows: ReturnType<typeof row>[],
    answers: Record<string, { ok: boolean; error?: string; result?: unknown }> = {},
  ) {
    const reg = { rows };
    const control = vi.fn(async (op: string, _f?: Record<string, unknown>) =>
      op === "claude_accounts"
        ? { ok: true, result: { accounts: reg.rows, primary: {} } }
        : (answers[op] ?? ({ ok: true } as { ok: boolean; error?: string; result?: unknown })),
    );
    return { reg, control, fn: control as unknown as ControlFn };
  }
  const view = (
    records: Record<string, ClaudeAccountPayload>,
    control: ControlFn | null,
    rev: number | undefined = 0,
  ) => (
    <main>
      <ClaudeAccounts
        accounts={records}
        signins={{}}
        config={config}
        control={control}
        configTransport={null}
        machines={machines}
        localName="hub"
        hosts={["box-a"]}
        registryRev={rev}
        group="accounts"
        now={NOW}
      />
    </main>
  );
  const fetches = (control: ReturnType<typeof vi.fn>) =>
    control.mock.calls.filter(([op]) => op === "claude_accounts").length;
  const card = (name = "Work") => screen.getByRole("article", { name });

  it("a raised rev fetches the registry again; a row it no longer has leaves, with no remount", async () => {
    const v = volleyd([row("work", "local")]);
    const r = render(view({ work: own }, v.fn));
    await waitFor(() => expect(fetches(v.control)).toBe(1));
    expect(card()).toBeInTheDocument();
    // volleyd removed it: its record cleared, the registry without it, the signal raised.
    v.reg.rows = [];
    r.rerender(view({}, v.fn, 0));
    // the stale registry still shows it until the signal moves
    expect(card()).toBeInTheDocument();
    r.rerender(view({}, v.fn, 1));
    await waitFor(() => expect(screen.queryByRole("article", { name: "Work" })).toBeNull());
    expect(fetches(v.control)).toBe(2);
  });

  it("Rename: ✎ opens a field holding the name; Enter sends claude_account_rename; the new name shows after the rev", async () => {
    const v = volleyd([row("work", "local"), row("work-box-a", "box-a")]);
    const r = render(view({ work: own }, v.fn));
    await waitFor(() => expect(fetches(v.control)).toBe(1));
    fireEvent.click(within(card()).getByRole("button", { name: "Rename Work" }));
    const field = within(card()).getByRole("textbox", { name: "New name for Work" });
    expect(field).toHaveValue("Work");
    fireEvent.change(field, { target: { value: "Team account" } });
    await act(async () => {
      fireEvent.keyDown(field, { key: "Enter" });
    });
    expect(v.control).toHaveBeenCalledWith(
      "claude_account_rename",
      { acct: "work", label: "Team account" },
      expect.any(String),
    );
    expect(within(card()).queryByRole("textbox")).toBeNull();
    v.reg.rows = [row("work", "local", "Team account"), row("work-box-a", "box-a", "Team account")];
    r.rerender(view({ work: { ...own, label: "Team account" } }, v.fn, 1));
    expect(await screen.findByRole("article", { name: "Team account" })).toBeInTheDocument();
  });

  it("Rename: Escape restores the name and sends nothing; a refusal shows under the field", async () => {
    const v = volleyd([row("work", "local")], {
      claude_account_rename: { ok: false, error: "'primary' is reserved; pick another name" },
    });
    render(view({ work: own }, v.fn));
    await waitFor(() => expect(fetches(v.control)).toBe(1));
    fireEvent.click(within(card()).getByRole("button", { name: "Rename Work" }));
    const field = within(card()).getByRole("textbox", { name: "New name for Work" });
    fireEvent.change(field, { target: { value: "Something" } });
    fireEvent.keyDown(field, { key: "Escape" });
    expect(within(card()).queryByRole("textbox")).toBeNull();
    expect(within(card()).getByText("Work", { selector: "b" })).toBeInTheDocument();
    expect(v.control).not.toHaveBeenCalledWith(
      "claude_account_rename",
      expect.anything(),
      expect.anything(),
    );
    fireEvent.click(within(card()).getByRole("button", { name: "Rename Work" }));
    const again = within(card()).getByRole("textbox", { name: "New name for Work" });
    fireEvent.change(again, { target: { value: "Primary" } });
    await act(async () => {
      fireEvent.keyDown(again, { key: "Enter" });
    });
    expect(within(card()).getByRole("alert")).toHaveTextContent("'primary' is reserved");
    expect(within(card()).getByRole("textbox")).toHaveValue("Primary");
  });

  it("Remove…: the sheet names the machine and the masked e-mail; Confirm sends the op", async () => {
    const v = volleyd([row("work", "local")]);
    render(view({ work: own }, v.fn));
    await waitFor(() => expect(fetches(v.control)).toBe(1));
    fireEvent.click(within(card()).getByRole("button", { name: "Remove Work…" }));
    const sheet = within(screen.getByRole("dialog", { name: "Remove Work" }));
    expect(sheet.queryByRole("radio")).toBeNull();
    expect(sheet.getByText("this machine", { selector: "b" })).toBeInTheDocument();
    expect(sheet.getByText("o•••@example.com")).toBeInTheDocument();
    expect(screen.getByRole("dialog").textContent).not.toContain(EMAIL);
    await act(async () => {
      fireEvent.click(sheet.getByRole("button", { name: "Remove from this machine" }));
    });
    expect(v.control).toHaveBeenCalledWith(
      "claude_account_remove",
      { acct: "work" },
      expect.any(String),
      expect.any(Number),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent("Work removed from this machine.");
  });

  it("Remove… on an account on several machines picks the machine; a refusal stays in the sheet", async () => {
    const v = volleyd([row("work", "local"), row("work-box-a", "box-a")], {
      claude_account_remove: {
        ok: false,
        error: "Claude account 'work-box-a@box-a' is in use by w1-t1-implementer-1",
      },
    });
    render(view({ work: own }, v.fn));
    await waitFor(() => expect(fetches(v.control)).toBe(1));
    fireEvent.click(within(card()).getByRole("button", { name: "Remove Work…" }));
    const sheet = within(screen.getByRole("dialog", { name: "Remove Work" }));
    const radios = sheet.getAllByRole("radio");
    expect(radios.map((r) => r.closest("label")?.querySelector("span")?.textContent)).toEqual([
      "this machine",
      "box-a",
    ]);
    expect(radios[0]).toBeChecked();
    fireEvent.click(sheet.getByRole("radio", { name: /box-a/ }));
    await act(async () => {
      fireEvent.click(sheet.getByRole("button", { name: "Remove from box-a" }));
    });
    expect(v.control).toHaveBeenCalledWith(
      "claude_account_remove",
      { acct: "work-box-a@box-a" },
      expect.any(String),
      expect.any(Number),
    );
    expect(sheet.getByRole("alert")).toHaveTextContent("in use by w1-t1-implementer-1");
    expect(screen.getByRole("dialog", { name: "Remove Work" })).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("this machine's own login has no Rename and no Remove", async () => {
    const v = volleyd([row("work", "local")]);
    render(view({ work: own }, v.fn));
    await waitFor(() => expect(fetches(v.control)).toBe(1));
    const primary = within(screen.getByRole("article", { name: "This machine's Claude login" }));
    expect(primary.queryByRole("button", { name: /^Rename/ })).toBeNull();
    expect(primary.queryByRole("button", { name: /^Remove/ })).toBeNull();
  });

  it("read-only: neither Rename nor Remove", () => {
    render(view({ work: own }, null));
    expect(within(card()).queryByRole("button", { name: /^Rename/ })).toBeNull();
    expect(within(card()).queryByRole("button", { name: /^Remove/ })).toBeNull();
  });

  it("a waiting profile's Cancel sends claude_account_remove for it", async () => {
    const pending = {
      id: "pending-work",
      label: "Work (box-a)",
      machine: "box-a",
      signin: { state: "pending" },
    };
    const v = volleyd([row("work", "local"), pending as unknown as ReturnType<typeof row>]);
    render(view({ work: own }, v.fn));
    const section = within(
      await screen.findByRole("region", { name: "Profiles waiting for sign-in" }),
    );
    await act(async () => {
      fireEvent.click(section.getByRole("button", { name: "Cancel Work (box-a)" }));
    });
    expect(v.control).toHaveBeenCalledWith(
      "claude_account_remove",
      { acct: "pending-work@box-a" },
      expect.any(String),
      expect.any(Number),
    );
  });

  it("passes axe with the remove sheet open, and with the rename field open", async () => {
    const v = volleyd([row("work", "local"), row("work-box-a", "box-a")]);
    render(view({ work: own }, v.fn));
    await waitFor(() => expect(fetches(v.control)).toBe(1));
    fireEvent.click(within(card()).getByRole("button", { name: "Remove Work…" }));
    const rules = { rules: { "color-contrast": { enabled: false } } };
    expect((await axe.run(document.body, rules)).violations.map((x) => x.id)).toEqual([]);
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
    fireEvent.click(within(card()).getByRole("button", { name: "Rename Work" }));
    expect((await axe.run(document.body, rules)).violations.map((x) => x.id)).toEqual([]);
  });
});

describe("the demo Desk: remove a profile, and every Settings section follows (#497)", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem(LOOK_STORAGE_KEY, JSON.stringify({ bg: "none", autoArrange: false }));
  });

  it("Remove… on Team (box-a) leaves its card's box-a row and Settings › Machines' box-a list", async () => {
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      value: () => {},
      configurable: true,
    });
    try {
      render(
        <DeskStoreProvider demo>
          <App />
        </DeskStoreProvider>,
      );
      const dock = within(screen.getByRole("toolbar", { name: "Dock" }));
      fireEvent.click(dock.getByRole("button", { name: "Machines" }));
      fireEvent.click(screen.getByRole("button", { name: "box-a: open in Settings › Machines" }));
      const onBoxA = () => screen.getByRole("list", { name: "Claude accounts on box-a" });
      const teamOnBoxA = () =>
        within(onBoxA())
          .getAllByRole("listitem")
          .find((li) => li.textContent?.includes("Team account"));
      await waitFor(() => expect(teamOnBoxA()).not.toHaveClass("gap"));

      const settings = within(screen.getByRole("dialog", { name: "Settings" }));
      fireEvent.click(settings.getByRole("button", { name: /Claude accounts & usage/ }));
      fireEvent.click(await settings.findByRole("button", { name: /^Accounts/ }));
      const team = await screen.findByRole("article", { name: "Team account" });
      fireEvent.click(within(team).getByRole("button", { name: "Remove Team account…" }));
      const sheet = within(screen.getByRole("dialog", { name: "Remove Team account" }));
      fireEvent.click(sheet.getByRole("radio", { name: /box-a/ }));
      fireEvent.click(sheet.getByRole("button", { name: "Remove from box-a" }));
      // the demo answers, clears the record, raises its signal; the card is fetched again
      await waitFor(
        () => {
          const rows = within(screen.getByRole("article", { name: "Team account" })).getByRole(
            "list",
            { name: "Machines" },
          );
          expect(within(rows).getByText("not on box-a")).toBeInTheDocument();
        },
        { timeout: 3000 },
      );

      fireEvent.click(settings.getByRole("button", { name: /^Machines/ }));
      await waitFor(() => expect(teamOnBoxA()).toHaveClass("gap"));
    } finally {
      Reflect.deleteProperty(Element.prototype, "scrollIntoView");
    }
  });

  it("Settings › Machines, left open, asks volleyd's registry again when the rev rises", async () => {
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      value: () => {},
      configurable: true,
    });
    try {
      render(
        <DeskStoreProvider demo>
          <App />
        </DeskStoreProvider>,
      );
      const dock = within(screen.getByRole("toolbar", { name: "Dock" }));
      fireEvent.click(dock.getByRole("button", { name: "Machines" }));
      fireEvent.click(screen.getByRole("button", { name: "box-a: open in Settings › Machines" }));
      screen.getByRole("list", { name: "Claude accounts on box-a" });
      const asked = () => demoFeed.asks.filter((op) => op === "claude_accounts").length;
      await waitFor(() => expect(asked()).toBeGreaterThan(0));
      const before = asked();
      const signal = (rev: number): DeskMessage => ({
        topic: "volley/_system/claude/registry",
        envelope: {
          schema_version: "0.1",
          agent_id: "volleyd",
          channel: "_system/claude",
          type: "claude_registry_changed",
          wall_time: new Date().toISOString(),
          namespace: "default",
          payload: { rev, at: new Date().toISOString() },
        },
        receivedAt: Date.now(),
      });
      act(() => demoFeed.apply?.([signal(41)]));
      await waitFor(() => expect(asked()).toBe(before + 1));
      // Settings › Machines stayed open throughout: no remount asked it
      expect(screen.getByRole("list", { name: "Claude accounts on box-a" })).toBeInTheDocument();
    } finally {
      Reflect.deleteProperty(Element.prototype, "scrollIntoView");
    }
  });
});

describe("ClaudeAccounts › adding ends primed (#498)", () => {
  const EMAIL = "team@example.com";
  /** A control that answers claude_accounts with `rows` and records every op. */
  const answering = (rows: () => unknown[]) => {
    const ops: { op: string; fields: Record<string, unknown> }[] = [];
    const fn = vi.fn(async (op: string, fields: Record<string, unknown>) => {
      ops.push({ op, fields });
      if (op === "claude_accounts")
        return { ok: true, result: { accounts: rows(), primary: {}, sharing: {} } };
      if (op === "claude_account_add")
        return { ok: true, result: { acct: "team-2", url: "https://example.com/oauth" } };
      return { ok: true };
    }) as unknown as ControlFn;
    return { fn, ops, primes: () => ops.filter((o) => o.op === "claude_prime") };
  };
  const card = (name: string) => within(screen.getByRole("article", { name }));
  const team = { id: "team", label: "Team", machine: "local", signed_in_at: SIGNED };
  const view = (
    control: ControlFn | null,
    now: number,
    more: Partial<ClaudeAccountsProps> = {},
  ) => (
    <ClaudeAccounts
      group="accounts"
      accounts={{}}
      signins={{}}
      config={config}
      control={control}
      configTransport={null}
      now={now}
      {...more}
    />
  );

  it("a card with no e-mail asks volleyd once on mount and not again within 5 min", async () => {
    const c = answering(() => [team]);
    const r = render(view(c.fn, NOW));
    await screen.findByRole("article", { name: "Team" });
    await waitFor(() => expect(c.primes().map((p) => p.fields)).toContainEqual({ acct: "team" }));
    // answered without an e-mail: `no reading yet` until the next ask
    await waitFor(() => expect(card("Team").queryAllByText(/^reading…/)).toHaveLength(0));
    expect(card("Team").queryByText(/doctor/i)).toBeNull();
    const sent = c.primes().filter((p) => p.fields.acct === "team").length;
    expect(sent).toBe(1);
    r.rerender(view(c.fn, NOW + 4 * 60_000));
    expect(c.primes().filter((p) => p.fields.acct === "team")).toHaveLength(1);
    r.rerender(view(c.fn, NOW + 5 * 60_000 + 1));
    await waitFor(() => expect(c.primes().filter((p) => p.fields.acct === "team")).toHaveLength(2));
  });

  it("after a prior probe the e-mail row says how old the last reading is", async () => {
    const c = answering(() => [team]);
    const record: ClaudeAccountPayload = {
      account: "team",
      label: "Team",
      five_hour: null,
      weekly: null,
      agents: [],
      waves: [],
      sampled_at: "2026-10-18T14:02:00.000Z",
      probe: { machine: "local", state: "error", attempted_at: "2026-10-18T14:02:00.000Z" },
    };
    render(view(c.fn, NOW, { accounts: { team: record } }));
    expect(await card("Team").findByText("reading… · last read 4 min ago")).toBeInTheDocument();
  });

  it("without control: `no reading yet`, and nothing is sent", () => {
    const record: ClaudeAccountPayload = {
      account: "team",
      label: "Team",
      five_hour: null,
      weekly: null,
      agents: [],
      waves: [],
      sampled_at: "2026-10-18T14:02:00.000Z",
    };
    render(view(null, NOW, { accounts: { team: record } }));
    // the e-mail row, and the two windows' hints
    expect(card("Team").getAllByText("no reading yet").length).toBeGreaterThanOrEqual(3);
    expect(card("Team").queryByText(/reading…|doctor/)).toBeNull();
    for (const name of ["5-hour", "7-day"])
      expect(card("Team").getByRole("meter", { name })).toHaveAttribute(
        "aria-valuetext",
        "no reading yet",
      );
  });

  it("the meters and the e-mail row read `reading…` while a prime is in flight, then `no reading yet`", async () => {
    let answer: (v: { ok: boolean }) => void = () => {};
    const fn = vi.fn((op: string) =>
      op === "claude_prime"
        ? new Promise((r) => {
            answer = r;
          })
        : Promise.resolve({ ok: true, result: { accounts: [team], primary: {}, sharing: {} } }),
    ) as unknown as ControlFn;
    render(view(fn, NOW));
    await screen.findByRole("article", { name: "Team" });
    await waitFor(() =>
      expect(card("Team").getByRole("meter", { name: "5-hour" })).toHaveAttribute(
        "aria-valuetext",
        "reading…",
      ),
    );
    // the e-mail row and the two windows' hints
    expect(card("Team").getAllByText("reading…").length).toBeGreaterThanOrEqual(3);
    await act(async () => answer({ ok: true }));
    expect(card("Team").getByRole("meter", { name: "5-hour" })).toHaveAttribute(
      "aria-valuetext",
      "no reading yet",
    );
    // the prime answered without an e-mail: the row stops claiming a read is under way
    expect(card("Team").queryAllByText(/^reading…/)).toHaveLength(0);
    expect(card("Team").getAllByText("no reading yet").length).toBeGreaterThanOrEqual(3);
  });

  it("Add: step 2 waits for sign-in; done says who signed in, with the plan chip; the card follows", async () => {
    let rows: unknown[] = [];
    const c = answering(() => rows);
    const signinUrl = signinMsg("team-2", "claude_signin_url", {
      url: "https://example.com/oauth",
    });
    const r = render(view(c.fn, NOW));
    fireEvent.click(screen.getByRole("button", { name: "+ Add Claude account" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Account label" }), {
      target: { value: "Team 2" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Sign in on this machine" }));
    });
    expect(screen.getByText(/Waiting for the sign-in to finish/)).toBeInTheDocument();
    const done = reduceAll(initialState(), [
      signinUrl,
      signinMsg("team-2", "claude_signin_done", { plan: "max", email: "new@example.com" }),
    ]);
    rows = [
      {
        id: "team-2",
        label: "Team 2",
        machine: "local",
        signed_in_at: SIGNED,
        email: "new@example.com",
      },
    ];
    const record: ClaudeAccountPayload = {
      account: "team-2",
      label: "Team 2",
      email: "new@example.com",
      five_hour: { pct: 3, resets_at: "2026-10-18T18:10:00.000Z" },
      weekly: { pct: 9, resets_at: "2026-10-21T09:00:00.000Z" },
      agents: [],
      waves: [],
      sampled_at: "2026-10-18T14:05:00.000Z",
    };
    r.rerender(view(c.fn, NOW, { signins: done.signins ?? {}, accounts: { "team-2": record } }));
    const signed = await screen.findByText(/^Signed in as/);
    expect(signed).toHaveTextContent("Signed in as n•••@example.com");
    expect(within(signed).getByText("max")).toHaveClass("chip");
    const teamCard = await screen.findByRole("article", { name: "Team 2" });
    expect(within(teamCard).getByText("n•••@example.com")).toBeInTheDocument();
    expect(within(teamCard).getAllByRole("meter")).toHaveLength(3);
  });

  it("a sign-in matching an account already on that machine says so and offers Keep both / Remove the new profile", async () => {
    const rows = () => [
      { ...team, email: EMAIL },
      { id: "team-2", label: "Team 2", machine: "local", signed_in_at: SIGNED, email: EMAIL },
    ];
    const c = answering(rows);
    const r = render(view(c.fn, NOW));
    fireEvent.click(screen.getByRole("button", { name: "+ Add Claude account" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Account label" }), {
      target: { value: "Team 2" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Sign in on this machine" }));
    });
    const done = reduceAll(initialState(), [
      signinMsg("team-2", "claude_signin_done", { plan: "team", email: EMAIL }),
    ]);
    r.rerender(view(c.fn, NOW, { signins: done.signins ?? {} }));
    expect(
      await screen.findByText("This is the same account as Team on this machine."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Keep both" })).toBeInTheDocument();
    const remove = screen.getByRole("button", { name: "Remove the new profile" });
    fireEvent.click(remove);
    // in flight: a second click sends nothing
    expect(remove).toBeDisabled();
    fireEvent.click(remove);
    expect(c.ops.filter((o) => o.op === "claude_account_remove")).toEqual([
      { op: "claude_account_remove", fields: { acct: "team-2" } },
    ]);
    expect(await screen.findByText("Removed the new profile.")).toBeInTheDocument();
    // nothing left claims it was added
    expect(screen.queryByText(/^Added:/)).toBeNull();
    expect(screen.queryByText(/signed in on this machine/)).toBeNull();
  });

  it("Keep both dismisses the prompt", async () => {
    const rows = () => [
      { ...team, email: EMAIL },
      { id: "team-2", label: "Team 2", machine: "local", signed_in_at: SIGNED, email: EMAIL },
    ];
    const c = answering(rows);
    const r = render(view(c.fn, NOW));
    fireEvent.click(screen.getByRole("button", { name: "+ Add Claude account" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Account label" }), {
      target: { value: "Team 2" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Sign in on this machine" }));
    });
    const done = reduceAll(initialState(), [
      signinMsg("team-2", "claude_signin_done", { plan: "team", email: EMAIL }),
    ]);
    r.rerender(view(c.fn, NOW, { signins: done.signins ?? {} }));
    fireEvent.click(await screen.findByRole("button", { name: "Keep both" }));
    expect(screen.queryByText(/same account as/)).toBeNull();
    expect(c.ops.some((o) => o.op === "claude_account_remove")).toBe(false);
  });
});
