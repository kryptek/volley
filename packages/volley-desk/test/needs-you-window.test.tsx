import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type Tier,
  ctxFrom,
  inboxAttention,
  inboxNeedsYou,
  needsYouTargets,
} from "../src/attention";
import { createSteerTransport } from "../src/steer/transport";
import { demoAutopilot, demoInbox } from "../src/store/fixtures";
import { initialState, reduceAll } from "../src/store/reducer";
import type { AgentView, DeskState, InboxItem } from "../src/store/types";
import { COORDS_ID } from "../src/windows/coordinators/CoordinatorsWindow";
import { answerCommand, holdChoices, holdCommand } from "../src/windows/inbox/InboxRow";
import { NeedsYouWindow, type NeedsYouWindowProps } from "../src/windows/inbox/NeedsYouWindow";
import {
  INBOX_FILTERS,
  inboxSources,
  matchesFilter,
  needsPerson,
} from "../src/windows/inbox/inboxFilters";
import { accentFor } from "../src/windows/wave/accent";

const NOW = Date.parse("2026-10-21T12:00:00.000Z");
const STATE = reduceAll(initialState(), [...demoAutopilot(NOW), ...demoInbox(NOW)]);
const CTX = { now: NOW };
const ITEMS = Object.values(STATE.inbox ?? {});
const item = (id: string) => ITEMS.find((i) => i.id === id) as InboxItem;
const DECISION = "d-autopilot-d-rv7";
const PICKER = "p-coord-a1b2c3-toolu_01AbCdEf";
const HANDOFF = "h-sess-9f2-12";
const RELEASE = "r-autopilot-publish";

const tiersOf = (items: readonly InboxItem[], state: DeskState = STATE): Record<string, Tier> =>
  Object.fromEntries(items.map((i) => [i.id, inboxAttention(i, state, ctxFrom(state, CTX)).tier]));

const frame: NeedsYouWindowProps["frame"] = {
  pos: { x: 0, y: 0 },
  z: 1,
  scale: 1,
  chrome: "glass",
  onMove: () => {},
  onFocus: () => {},
};

function setup(over: Partial<NeedsYouWindowProps> = {}) {
  const items = over.items ?? ITEMS;
  const props: NeedsYouWindowProps = {
    items,
    tiers: tiersOf(items),
    waves: STATE.waves,
    control: vi.fn(async () => ({ ok: true })),
    device: "phone",
    frame,
    onClose: vi.fn(),
    onGoTo: vi.fn(),
    loadEvidence: async () => null,
    ...over,
  };
  const r = render(<NeedsYouWindow {...props} />);
  return { props, ...r };
}

const row = (id: string) => screen.getByRole("listitem", { name: new RegExp(id) });

afterEach(() => {
  vi.useRealTimers();
});

describe("inbox attention (attention.ts)", () => {
  it("owner-only and wave-less items need you; a wave's decision is its coordinator's", () => {
    const t = tiersOf(ITEMS);
    expect(t[RELEASE]).toBe("you");
    expect(t[PICKER]).toBe("you");
    expect(t[HANDOFF]).toBe("you");
    expect(t[DECISION]).toBe("coordinator");
  });

  it("a wave decision needs you once it waited escalate_after_min, or the wave is mine", () => {
    const late = inboxAttention(item(DECISION), STATE, ctxFrom(STATE, { now: NOW + 20 * 60_000 }));
    expect(late.tier).toBe("you");
    const mine = inboxAttention(item(DECISION), STATE, ctxFrom(STATE, { now: NOW, me: "lead" }));
    expect(mine.tier).toBe("you");
  });

  it("an answered item needs nobody", () => {
    const answered = {
      ...item(PICKER),
      answered: { answer: "SQLite", by: "desk", where: { kind: "desk" as const }, at: "x" },
    };
    expect(inboxAttention(answered, STATE, ctxFrom(STATE, CTX)).tier).toBe("none");
    expect(needsPerson(answered, "you")).toBe(false);
  });

  it("inboxNeedsYou lists the open items a person must answer", () => {
    expect(
      inboxNeedsYou(STATE, CTX)
        .map((i) => i.id)
        .sort(),
    ).toEqual([HANDOFF, PICKER, RELEASE].sort());
  });

  it("the top-bar pill's targets include the inbox's items", () => {
    const targets = needsYouTargets(STATE, CTX);
    const inbox = targets.filter((t) => t.kind === "inbox").map((t) => t.id);
    expect(inbox.sort()).toEqual([HANDOFF, PICKER, RELEASE].sort());
  });
});

describe("the filters", () => {
  it("are All / Only you / Pickers / Decisions / Handoffs", () => {
    expect(INBOX_FILTERS.map((f) => f.label)).toEqual([
      "All",
      "Only you",
      "Pickers",
      "Decisions",
      "Handoffs",
    ]);
  });

  it("each predicate keeps its kind; Only you keeps owner-only and you-tier items", () => {
    const t = tiersOf(ITEMS);
    const keep = (f: Parameters<typeof matchesFilter>[1]) =>
      ITEMS.filter((i) => matchesFilter(i, f, t[i.id] ?? "none"))
        .map((i) => i.id)
        .sort();
    expect(keep("all")).toHaveLength(4);
    expect(keep("you")).toEqual([HANDOFF, PICKER, RELEASE].sort());
    expect(keep("pickers")).toEqual([PICKER]);
    expect(keep("decisions")).toEqual([DECISION, RELEASE].sort());
    expect(keep("handoffs")).toEqual([HANDOFF]);
  });

  it("switching tabs filters the rows", () => {
    setup();
    expect(screen.getAllByRole("listitem", { name: /^Inbox item/ })).toHaveLength(4);
    fireEvent.click(screen.getByRole("tab", { name: "Pickers" }));
    expect(screen.getAllByRole("listitem", { name: /^Inbox item/ })).toHaveLength(1);
    expect(row(PICKER)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Only you" }));
    expect(screen.queryByRole("listitem", { name: new RegExp(DECISION) })).toBeNull();
    expect(screen.getAllByRole("listitem", { name: /^Inbox item/ })).toHaveLength(3);
  });
});

describe("the Needs you window", () => {
  it("lists one row per item, with the kind, title and question, a bar in the wave's colour", () => {
    setup();
    const d = row(DECISION);
    expect(within(d).getByText("Reviewers disagree · autopilot/T7")).toBeInTheDocument();
    expect(within(d).getByText(/missing retry a P1/)).toBeInTheDocument();
    expect(within(d).getByText("decision")).toBeInTheDocument();
    expect((d.querySelector(".inbox-bar") as HTMLElement).style.background).toBe(
      hexToRgb(accentFor("autopilot")),
    );
    expect(within(row(PICKER)).getByText("picker")).toBeInTheDocument();
    expect(within(row(HANDOFF)).getByText("handoff")).toBeInTheDocument();
    expect(within(row(RELEASE)).getByText("release")).toBeInTheDocument();
  });

  it("rows are SpotlightCards; only the owner-only release item wears a StarBorder", () => {
    setup();
    for (const id of [DECISION, PICKER, HANDOFF, RELEASE])
      expect(row(id).querySelector(".spotlight-card")).not.toBeNull();
    expect(row(RELEASE).querySelector(".star-border")).not.toBeNull();
    expect(within(row(RELEASE)).getByText("owner only")).toBeInTheDocument();
    for (const id of [DECISION, PICKER, HANDOFF])
      expect(row(id).querySelector(".star-border")).toBeNull();
  });

  it("the title counts what needs you, and the pulse ring is on while any is open", () => {
    const { container } = setup();
    expect(screen.getByText("3 need you")).toBeInTheDocument();
    expect(container.querySelector(".win-attn-pulse")).not.toBeNull();
  });

  it("no pulse ring when nothing open needs a person", () => {
    const { container } = setup({ items: [item(DECISION)] });
    expect(container.querySelector(".win-attn-pulse")).toBeNull();
  });

  it("the live line is ShinyText", () => {
    setup({ live: { [PICKER]: "Reading the cache module" } });
    const line = within(row(PICKER)).getAllByText("Reading the cache module")[0];
    expect(line?.closest(".shiny-text")).not.toBeNull();
  });

  it("an option sends one inbox_answer with the item's version and the device", async () => {
    const control = vi.fn(async () => ({ ok: true }));
    setup({ control });
    fireEvent.click(within(row(DECISION)).getByRole("button", { name: "blocker" }));
    await waitFor(() => expect(control).toHaveBeenCalledTimes(1));
    expect(control).toHaveBeenCalledWith(
      "inbox_answer",
      {
        id: DECISION,
        version: 2,
        answer: "blocker",
        where: { kind: "desk", device: "phone" },
      },
      `volleyd inbox answer '${DECISION}' 'blocker'`,
    );
  });

  it("a spawn decision's it's running button carries its hover text (#402)", async () => {
    const help =
      "Volley checks the agent is alive, then closes this. Nothing is restarted or stopped.";
    const spawn: InboxItem = {
      ...item(DECISION),
      options: [
        { label: "relaunch" },
        { label: "cancel" },
        { label: "it's running", description: help },
      ],
      source: { decision_id: "unknown_screen-w1-a1", decision_kind: "unknown_screen" },
    };
    const control = vi.fn(async () => ({ ok: true }));
    setup({ items: [spawn], control });
    const btn = within(row(DECISION)).getByRole("button", { name: "it's running" });
    expect(btn.getAttribute("title")).toBe(help);
    fireEvent.click(btn);
    await waitFor(() => expect(control).toHaveBeenCalledTimes(1));
    expect(control).toHaveBeenCalledWith(
      "inbox_answer",
      expect.objectContaining({ id: DECISION, answer: "it's running" }),
      expect.any(String),
    );
  });

  it("through the steer transport the answer is one publish to volleyd's mailbox", async () => {
    const publish = vi.fn(async () => {});
    const transport = createSteerTransport(
      { publish, onMessage: () => () => {} },
      { identity: "desk-1", onEvent: () => {}, timeoutMs: 50 },
    );
    setup({ control: transport.control });
    fireEvent.click(within(row(PICKER)).getByRole("button", { name: /SQLite/ }));
    await waitFor(() => expect(publish).toHaveBeenCalledTimes(1));
    const [topic, raw] = publish.mock.calls[0] as unknown as [string, string];
    expect(topic).toBe("volley/default/volleyd/mailbox");
    expect(JSON.parse(raw).payload).toMatchObject({
      op: "inbox_answer",
      id: PICKER,
      version: 1,
      answer: "SQLite",
      where: { kind: "desk", device: "phone" },
    });
  });

  it("Other… opens a text field when the item allows it", async () => {
    const control = vi.fn(async () => ({ ok: true }));
    setup({ control });
    const r = within(row(HANDOFF));
    fireEvent.click(r.getByRole("button", { name: "Other…" }));
    fireEvent.change(r.getByRole("textbox", { name: "Your answer" }), {
      target: { value: "only the new ones" },
    });
    fireEvent.click(r.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(control).toHaveBeenCalledTimes(1));
    expect((control.mock.calls[0] as unknown[])[1]).toMatchObject({ answer: "only the new ones" });
    expect(within(row(RELEASE)).queryByRole("button", { name: "Other…" })).toBeNull();
  });

  it("a refusal is shown on the row, which flips to answered", async () => {
    const control = vi.fn(async () => ({ ok: false, error: "already answered on mbp·terminal" }));
    setup({ control });
    fireEvent.click(within(row(PICKER)).getByRole("button", { name: /Redis/ }));
    const r = within(row(PICKER));
    expect(await r.findByText("already answered on mbp·terminal")).toBeInTheDocument();
    expect(r.queryByRole("button", { name: /Redis/ })).toBeNull();
    expect(row(PICKER).querySelector(".status-mark")).not.toBeNull();
  });

  it("another failure is shown and the buttons stay", async () => {
    const control = vi.fn(async () => ({ ok: false, error: "volleyd did not answer within 10s" }));
    setup({ control });
    fireEvent.click(within(row(PICKER)).getByRole("button", { name: /Redis/ }));
    const r = within(row(PICKER));
    expect(await r.findByText("volleyd did not answer within 10s")).toBeInTheDocument();
    expect(r.getByRole("button", { name: /Redis/ })).toBeEnabled();
  });

  it("an answered item shows StatusMark with where it was answered, and no options", () => {
    const answered: InboxItem = {
      ...item(DECISION),
      version: 3,
      answered: {
        answer: "fine",
        by: "owner",
        where: { kind: "desk", device: "phone" },
        at: "2026-10-21T12:00:00Z",
      },
    };
    setup({ items: [answered] });
    const r = within(row(DECISION));
    expect(r.getByText("answered on desk·phone · fine")).toBeInTheDocument();
    expect(row(DECISION).querySelector(".status-mark")).not.toBeNull();
    expect(r.queryByRole("button", { name: "blocker" })).toBeNull();
  });

  it("an answered row fades once its record clears", () => {
    vi.useFakeTimers();
    const { props, rerender } = setup();
    rerender(<NeedsYouWindow {...props} items={ITEMS.filter((i) => i.id !== PICKER)} />);
    expect(row(PICKER)).toHaveClass("inbox-row--leaving");
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.queryByRole("listitem", { name: new RegExp(PICKER) })).toBeNull();
  });

  it("a fading row still clears when a store update hands over a new array mid-fade", () => {
    vi.useFakeTimers();
    const { props, rerender } = setup();
    const rest = ITEMS.filter((i) => i.id !== PICKER);
    rerender(<NeedsYouWindow {...props} items={rest} />);
    act(() => {
      vi.advanceTimersByTime(100);
    });
    rerender(<NeedsYouWindow {...props} items={[...rest]} />);
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(screen.queryByRole("listitem", { name: new RegExp(PICKER) })).toBeNull();
  });

  it("without broker credentials an option offers the copyable volleyd command", () => {
    setup({ control: null });
    fireEvent.click(within(row(DECISION)).getByRole("button", { name: "blocker" }));
    expect(
      within(row(DECISION)).getByText(`volleyd inbox answer '${DECISION}' 'blocker'`),
    ).toBeInTheDocument();
    expect(within(row(DECISION)).getByRole("button", { name: "Copy command" })).toBeInTheDocument();
  });

  it("go-to, Show and Dismiss, like the coordinators window", () => {
    const onGoTo = vi.fn();
    const onShow = vi.fn();
    setup({ onGoTo, onShow });
    fireEvent.click(within(row(DECISION)).getByRole("button", { name: /^Go to/ }));
    expect(onGoTo).toHaveBeenCalledWith(item(DECISION));
    fireEvent.click(within(row(DECISION)).getByRole("button", { name: /^Show/ }));
    expect(onShow).toHaveBeenCalledWith(item(DECISION));
    fireEvent.click(within(row(HANDOFF)).getByRole("button", { name: /^Dismiss/ }));
    expect(screen.queryByRole("listitem", { name: new RegExp(HANDOFF) })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Bring back" }));
    expect(row(HANDOFF)).toBeInTheDocument();
  });
});

describe("tethers", () => {
  it("each row is tethered from its source window: wave, agent or coordinators", () => {
    const agent = { id: "sess-9f2", wave: "UNASSIGNED" } as AgentView;
    const state: DeskState = {
      ...STATE,
      agents: { ...STATE.agents, "sess-9f2": agent },
      coordinators: { "coord-a1b2c3": { id: "coord-a1b2c3", waves: [], state: "working" } },
    };
    expect(inboxSources(ITEMS, state)).toEqual(
      expect.arrayContaining([
        { id: `inbox:${DECISION}`, source: "autopilot" },
        { id: `inbox:${RELEASE}`, source: "autopilot" },
        { id: `inbox:${PICKER}`, source: COORDS_ID },
        { id: `inbox:${HANDOFF}`, source: "sess-9f2" },
      ]),
    );
  });

  it("an item whose source has no window gets no tether", () => {
    expect(inboxSources([item(HANDOFF)], STATE)).toEqual([]);
  });
});

function hexToRgb(hex: string): string {
  const n = Number.parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
}

describe("the device an answer names", () => {
  afterEach(() => localStorage.clear());

  it("is the name set in Settings › General, else phone / desktop by width", async () => {
    const { deskDevice, writeDeviceLabel } = await import("../src/steer/transport");
    expect(deskDevice(true)).toBe("phone");
    expect(deskDevice(false)).toBe("desktop");
    writeDeviceLabel("  kitchen-ipad ");
    expect(deskDevice(true)).toBe("kitchen-ipad");
    writeDeviceLabel("");
    expect(deskDevice(true)).toBe("phone");
  });
});

describe("answerCommand", () => {
  it("single-quotes the answer so a pasted command never expands $(…), backticks or $VAR", () => {
    expect(answerCommand("inbox-1", "$(curl x|sh) `id` $HOME it's")).toBe(
      "volleyd inbox answer 'inbox-1' '$(curl x|sh) `id` $HOME it'\\''s'",
    );
  });
});

describe("held decisions (SPEC §4.6.2)", () => {
  const decisionItem = item(DECISION);
  const choices = holdChoices(decisionItem, STATE.waves[decisionItem.wave as string]);

  it("the hold picker lists the wave's other unsettled tasks and their open PRs, and sends hold", async () => {
    expect(choices.length).toBeGreaterThan(0);
    expect(choices.every((c) => c.on.task !== decisionItem.task)).toBe(true);
    const { props } = setup({ items: [decisionItem] });
    fireEvent.click(within(row(DECISION)).getByRole("button", { name: "Hold · waiting on…" }));
    const select = within(row(DECISION)).getByRole("combobox", { name: "Hold · waiting on" });
    const first = choices[0] as (typeof choices)[number];
    await act(async () => {
      fireEvent.change(select, { target: { value: first.key } });
    });
    expect(props.control).toHaveBeenCalledWith(
      "hold",
      { item: DECISION, on: first.on },
      holdCommand(DECISION, first.on),
    );
  });

  it("a held row is amber with what it waits on, offers Release, and never needs a person", async () => {
    const held = {
      ...decisionItem,
      owner_only: true,
      held: { on: { pr: 194 }, by: "lead", at: new Date(NOW - 3 * 3_600_000).toISOString() },
    };
    expect(needsPerson(held, "you")).toBe(false);
    const { props } = setup({ items: [held], tiers: { [DECISION]: "coordinator" }, now: NOW });
    const r = row(DECISION);
    expect(r.className).toContain("inbox-row--held");
    expect(within(r).getByText("Held · waiting on PR #194 · 3 h")).toBeTruthy();
    expect(within(r).queryByText("needs you")).toBeNull();
    expect(screen.queryByText(/need you$/)).toBeNull();
    await act(async () => {
      fireEvent.click(within(r).getByRole("button", { name: "Release" }));
    });
    expect(props.control).toHaveBeenCalledWith(
      "release",
      { item: DECISION },
      expect.stringContaining("volleyd release"),
    );
  });

  it("Release is disabled while its op is in flight, so a double click sends one", async () => {
    let finish: (r: { ok: boolean }) => void = () => {};
    const control = vi.fn(
      () =>
        new Promise<{ ok: boolean }>((res) => {
          finish = res;
        }),
    );
    const held = {
      ...decisionItem,
      held: { on: { pr: 194 }, by: "lead", at: new Date(NOW - 60_000).toISOString() },
    };
    setup({ items: [held], control, now: NOW });
    const release = within(row(DECISION)).getByRole("button", { name: "Release" });
    await act(async () => {
      fireEvent.click(release);
    });
    expect(release).toBeDisabled();
    fireEvent.click(release);
    expect(control).toHaveBeenCalledTimes(1);
    await act(async () => finish({ ok: true }));
    expect(release).not.toBeDisabled();
  });

  it("a refused hold resets the picker, so the same choice can be picked again", async () => {
    const control = vi.fn(async () => ({ ok: false, error: "volleyd refused the hold" }));
    setup({ items: [decisionItem], control });
    fireEvent.click(within(row(DECISION)).getByRole("button", { name: "Hold · waiting on…" }));
    const select = within(row(DECISION)).getByRole("combobox", {
      name: "Hold · waiting on",
    }) as HTMLSelectElement;
    const first = choices[0] as (typeof choices)[number];
    await act(async () => {
      fireEvent.change(select, { target: { value: first.key } });
    });
    expect(screen.getByText("volleyd refused the hold")).toBeTruthy();
    expect(select.value).toBe("");
  });

  it("without credentials, the hold is a command to copy", () => {
    setup({ items: [decisionItem], control: null });
    fireEvent.click(within(row(DECISION)).getByRole("button", { name: "Hold · waiting on…" }));
    const first = choices[0] as (typeof choices)[number];
    fireEvent.change(within(row(DECISION)).getByRole("combobox", { name: "Hold · waiting on" }), {
      target: { value: first.key },
    });
    expect(screen.getByText(holdCommand(DECISION, first.on))).toBeTruthy();
  });
});
