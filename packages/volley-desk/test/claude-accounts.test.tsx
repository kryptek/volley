import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  ClaudeAccounts,
  type ClaudeAccountsProps,
  type ControlFn,
} from "../src/settings/ClaudeAccounts";
import { SettingsModal } from "../src/settings/SettingsModal";
import { accountList } from "../src/store/claude";
import { initialState, reduceAll } from "../src/store/reducer";
import type {
  ClaudeAccountPayload,
  ConfigPayload,
  DecisionPayload,
  DeskMessage,
  WaveView,
} from "../src/store/types";

const NOW = Date.parse("2026-10-18T14:06:00.000Z");

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

const wave = (decisions: Record<string, DecisionPayload>): WaveView => ({
  id: "w1",
  state: null,
  decisions,
  receivedAt: NOW,
});

function setup(extra: DeskMessage[] = [], props: Partial<ClaudeAccountsProps> = {}) {
  const state = reduceAll(initialState(), [accountMsg(work), accountMsg(personal), ...extra]);
  const control = vi.fn(async () => ({ ok: true }) as { ok: boolean; result?: unknown });
  const view = (s = state, more: Partial<ClaudeAccountsProps> = {}) => (
    <ClaudeAccounts
      accounts={s.claudeAccounts ?? {}}
      signins={s.signins ?? {}}
      waves={{ w1: wave({}) }}
      config={config}
      control={control}
      configTransport={null}
      now={NOW}
      {...props}
      {...more}
    />
  );
  const r = render(view());
  return { ...r, state, control, view };
}

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
    expect(cards).toHaveLength(2);
    const w = within(screen.getByRole("article", { name: "Work" }));
    expect(w.getByText("max")).toHaveClass("chip");
    const five = w.getByRole("meter", { name: "5-hour window" });
    expect(five).toHaveAttribute("aria-valuenow", "91");
    expect(five.closest(".meter")).toHaveTextContent("91%");
    expect(five.closest(".meter")).toHaveTextContent("resets in 4h 4m");
    expect(five.closest(".meter")?.querySelector(".meter-pct")).toHaveClass("meter-hot");
    const week = w.getByRole("meter", { name: "This week" });
    expect(week.closest(".meter")).toHaveTextContent("43%");
    expect(week.closest(".meter")).toHaveTextContent("resets in 2d 18h");
    expect(w.getByText("2 agents")).toBeInTheDocument();
    expect(w.getByText("waves: w1")).toBeInTheDocument();
    const p = within(screen.getByRole("article", { name: "Personal" }));
    expect(p.getByRole("meter", { name: "5-hour window" }).closest(".meter")).toHaveTextContent(
      "12%",
    );
    expect(p.getByText("no waves assigned")).toBeInTheDocument();
  });

  it("shows the open account_limit decision as a banner; Move resolves it", async () => {
    const { control } = setup([], { waves: { w1: wave({ [limit.decision_id]: limit }) } });
    const banner = screen.getByRole("status");
    expect(banner).toHaveTextContent("Needs you: Work is at 91% of its 5-hour window");
    await act(async () => {
      fireEvent.click(within(banner).getByRole("button", { name: "Move to Personal" }));
    });
    expect(control).toHaveBeenCalledWith(
      "resolve",
      { wave: "w1", decision_id: "d-7k2m9q4x", answer: "move wave w1 to personal" },
      expect.any(String),
    );
  });

  it("labels a suggested account with no usage yet (a newly signed-in profile) as such", async () => {
    const fresh = { ...limit, options: ["move wave w1 to fresh", "not now"], suggested: "fresh" };
    const { control } = setup([], {
      waves: { w1: wave({ [fresh.decision_id]: fresh }) },
      onRegistry: () => {},
    });
    const banner = screen.getByRole("status");
    expect(banner).toHaveTextContent("Move wave w1 to fresh (no usage yet)?");
    await act(async () => {
      fireEvent.click(within(banner).getByRole("button", { name: "Move to fresh" }));
    });
    expect(control).toHaveBeenCalledWith(
      "resolve",
      { wave: "w1", decision_id: "d-7k2m9q4x", answer: "move wave w1 to fresh" },
      expect.any(String),
    );
  });

  it("Not now answers the decision with its not-now option", async () => {
    const { control } = setup([], { waves: { w1: wave({ [limit.decision_id]: limit }) } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    });
    expect(control).toHaveBeenCalledWith(
      "resolve",
      { wave: "w1", decision_id: "d-7k2m9q4x", answer: "not now" },
      expect.any(String),
    );
  });

  it("no open decision, no banner", () => {
    setup([], {
      waves: {
        w1: wave({
          [limit.decision_id]: { ...limit, resolved: { answer: "not now", by: "desk", at: "x" } },
        }),
      },
    });
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("Move a wave here… answers the wave's open decision with this account", async () => {
    const { control } = setup([], { waves: { w1: wave({ [limit.decision_id]: limit }) } });
    const card = within(screen.getByRole("article", { name: "Personal" }));
    await act(async () => {
      fireEvent.change(card.getByRole("combobox", { name: "Move a wave to Personal" }), {
        target: { value: "w1" },
      });
    });
    expect(control).toHaveBeenCalledWith(
      "resolve",
      { wave: "w1", decision_id: "d-7k2m9q4x", answer: "move wave w1 to personal" },
      expect.any(String),
    );
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
    expect(screen.getByText(/Waiting for the sign-in to finish/)).toBeInTheDocument();
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
    setup([], { configTransport: { identity: "desk", send } });
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
    setup([], { control: null, waves: { w1: wave({ [limit.decision_id]: limit }) } });
    expect(screen.getByRole("button", { name: "+ Add Claude account" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Move to Personal" })).toBeNull();
    expect(screen.queryByRole("radiogroup")).toBeNull();
    expect(screen.getByText("Most headroom")).toBeInTheDocument();
  });
});

describe("ClaudeAccounts review fixes", () => {
  const remote: ClaudeAccountPayload = {
    ...personal,
    account: "team@box",
    label: "Team",
    plan: "max",
  };

  it("Defaults shows a rejected config_set the way Supervisor's rows do", async () => {
    const send = vi.fn(async () => ({
      applied: false,
      rejected: [{ path: "claude.default_account", reason: "unknown account" }],
    }));
    setup([], { configTransport: { identity: "desk", send } });
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
    setup([], { configTransport: { identity: "desk", send } });
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

  it("Add offers only this machine; a remote host gets the command to run there", () => {
    setup([accountMsg(remote)]);
    fireEvent.click(screen.getByRole("button", { name: "+ Add Claude account" }));
    expect(screen.getByRole("button", { name: "Sign in on this machine" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Sign in on box/ })).toBeNull();
    expect(screen.getByText("volley claude add").closest("p")).toHaveTextContent(
      "To add one on box, run volley claude add there",
    );
  });

  it("a remote account's card does not offer to move a wave there", () => {
    setup([accountMsg(remote)], { waves: { w1: wave({ [limit.decision_id]: limit }) } });
    const card = within(screen.getByRole("article", { name: "Team" }));
    expect(card.getByRole("combobox", { name: "Move a wave to Team" })).toBeDisabled();
  });

  it("Move / Not now are disabled while an answer is in flight", async () => {
    const { control } = setup([], { waves: { w1: wave({ [limit.decision_id]: limit }) } });
    let release: (v: { ok: boolean }) => void = () => {};
    control.mockImplementationOnce(
      () =>
        new Promise((r) => {
          release = r;
        }),
    );
    const banner = within(screen.getByRole("status"));
    fireEvent.click(banner.getByRole("button", { name: "Move to Personal" }));
    expect(banner.getByRole("button", { name: "Move to Personal" })).toBeDisabled();
    expect(banner.getByRole("button", { name: "Not now" })).toBeDisabled();
    expect(
      within(screen.getByRole("article", { name: "Personal" })).getByRole("combobox"),
    ).toBeDisabled();
    fireEvent.click(banner.getByRole("button", { name: "Move to Personal" }));
    expect(control.mock.calls.filter((c) => (c as unknown[])[0] === "resolve")).toHaveLength(1);
    await act(async () => release({ ok: true }));
    expect(banner.getByRole("button", { name: "Not now" })).toBeEnabled();
  });

  it("the resets-in time keeps up with the clock while the section is open", () => {
    vi.useFakeTimers({ now: NOW, toFake: ["Date", "setInterval", "clearInterval"] });
    try {
      const state = reduceAll(initialState(), [accountMsg(work)]);
      render(
        <ClaudeAccounts
          accounts={state.claudeAccounts ?? {}}
          signins={{}}
          waves={{}}
          config={config}
          control={null}
          configTransport={null}
        />,
      );
      const five = () => screen.getByRole("meter", { name: "5-hour window" }).closest(".meter");
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

describe("SettingsModal › the wave's Claude account", () => {
  const accounts = accountList({
    work,
    personal,
    "team@box": { ...personal, account: "team@box", label: "Team" },
  });
  const withFresh = accountList({ work, personal }, [
    { id: "fresh", label: "Fresh", machine: "local", signed_in_at: "2026-10-18T13:00:00.000Z" },
  ]);
  const modal = (decisions: Record<string, DecisionPayload>, control: ControlFn | null) =>
    render(
      <SettingsModal
        wave={wave(decisions)}
        onClose={() => {}}
        onOpenGlobal={() => {}}
        accounts={accounts}
        control={control}
      />,
    );

  it("names the accounts the wave runs on, with no picker while no decision is open", () => {
    modal({}, vi.fn());
    expect(screen.getByText("Work")).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: /Move wave w1/ })).toBeNull();
    expect(screen.getByText(/offers a move when the account nears its limit/)).toBeInTheDocument();
  });

  it("with an open account_limit decision, picks a local account and resolves the move", async () => {
    const control = vi.fn(async () => ({ ok: true }));
    modal({ [limit.decision_id]: limit }, control);
    const pick = screen.getByRole("combobox", { name: "Move wave w1 to a Claude account" });
    const options = within(pick)
      .getAllByRole("option")
      .map((o) => o.textContent);
    expect(options).toEqual(["Move new agents to…", "Personal · 12%"]);
    await act(async () => {
      fireEvent.change(pick, { target: { value: "personal" } });
    });
    expect(control).toHaveBeenCalledWith("resolve", {
      wave: "w1",
      decision_id: "d-7k2m9q4x",
      answer: "move wave w1 to personal",
    });
  });

  it("labels an account with no usage yet in the picker", () => {
    render(
      <SettingsModal
        wave={wave({ [limit.decision_id]: limit })}
        onClose={() => {}}
        onOpenGlobal={() => {}}
        accounts={withFresh}
        control={vi.fn(async () => ({ ok: true }))}
      />,
    );
    const pick = screen.getByRole("combobox", { name: "Move wave w1 to a Claude account" });
    expect(
      within(pick)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["Move new agents to…", "Personal · 12%", "Fresh · no usage yet"]);
  });

  it("shows volleyd's refusal", async () => {
    const control = vi.fn(async () => ({ ok: false, error: "decision already resolved" }));
    modal({ [limit.decision_id]: limit }, control);
    await act(async () => {
      fireEvent.change(screen.getByRole("combobox", { name: "Move wave w1 to a Claude account" }), {
        target: { value: "personal" },
      });
    });
    expect(screen.getByRole("alert")).toHaveTextContent("decision already resolved");
  });

  it("read-only: no picker even with a decision open", () => {
    modal({ [limit.decision_id]: limit }, null);
    expect(screen.queryByRole("combobox", { name: /Move wave w1/ })).toBeNull();
  });
});
