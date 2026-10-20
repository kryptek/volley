import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { demoMessages } from "../src/store/fixtures";
import { initialState, reduceAll } from "../src/store/reducer";
import type { DeskMessage, DeskState } from "../src/store/types";
import { AgentWindow } from "../src/windows/agent/AgentWindow";
import { NO_TERMINAL } from "../src/windows/agent/Terminal";

const NOW = Date.parse("2026-10-18T12:00:00Z");
const FIXUP = "status-chip-t1-fixup-1";

const frame = {
  pos: { x: 0, y: 0 },
  z: 1,
  scale: 1,
  chrome: "glass" as const,
  onMove: () => {},
  onFocus: () => {},
};

function msg(
  id: string,
  channel: string,
  type: string,
  payload: Record<string, unknown>,
  at: number,
  extra: Record<string, unknown> = {},
): DeskMessage {
  const topic =
    channel === "_system/registry"
      ? `volley/_system/registry/${id}`
      : `volley/default/${id}/${channel}`;
  return {
    topic,
    envelope: {
      schema_version: "0.1",
      agent_id: id,
      wall_time: new Date(at).toISOString(),
      channel,
      type,
      payload,
      ...extra,
    },
    receivedAt: at,
  };
}

/** A registry entry (parent `coordinator-ab12` unless given) plus a `working` status. */
function adhoc(
  id: string,
  payload: Record<string, unknown>,
  parent: string | null = "coordinator-ab12",
) {
  const at = NOW - 60_000;
  const reg = { capabilities: [], started_at: new Date(at).toISOString(), ...payload };
  return [
    msg(id, "_system/registry", "registered", reg, at, { parent_id: parent }),
    msg(id, "status", "working", {}, at, { parent_id: parent }),
  ];
}

const stateWith = (...extra: DeskMessage[]): DeskState =>
  reduceAll(initialState(), [...demoMessages(NOW), ...extra]);

function renderAgent(state: DeskState, id: string, extra: { now?: number; stale?: string } = {}) {
  const agent = state.agents[id];
  if (!agent) throw new Error(`no agent ${id}`);
  return render(
    <AgentWindow
      agent={agent}
      wave={state.waves[agent.wave]}
      accent="#c4b5fd"
      frame={frame}
      now={extra.now ?? NOW}
      {...(extra.stale ? { stale: extra.stale } : {})}
    />,
  );
}

describe("purpose line", () => {
  it("a wave agent: `<task> · <title>`, the role chip, the issue linked, the id on a secondary line", () => {
    const { container } = renderAgent(stateWith(), FIXUP);
    const bar = container.querySelector(".win-bar") as HTMLElement;
    expect(bar.querySelector(".t-name")).toHaveTextContent("T1 · Chip mapper + null-case handling");
    expect(within(bar).getByText("fixup")).toHaveClass("chip--role");
    expect(container.querySelector(".a-purpose-text")).toHaveTextContent(
      "T1 · Chip mapper + null-case handling",
    );
    const issue = screen.getByRole("link", { name: "#102" });
    expect(issue).toHaveAttribute("target", "_blank");
    expect(issue.getAttribute("href")).toMatch(
      /^https:\/\/github\.com\/[^/]+\/[^/]+\/issues\/102$/,
    );
    expect(container.querySelector(".a-id")).toHaveTextContent(FIXUP);
    expect(within(bar).queryByText(FIXUP)).toBeNull();
  });

  it("an ad-hoc agent with a registered title: bold at the top, the window's name, the id secondary", () => {
    const id = "coordinator-8fb2";
    const title = "#155 C13 parity — spec review";
    const { container } = renderAgent(stateWith(...adhoc(id, { title })), id);
    expect(container.querySelector(".a-purpose-text")).toHaveTextContent(title);
    expect(container.querySelector(".win-bar .t-name")).toHaveTextContent(title);
    expect(container.querySelector(".a-id")).toHaveTextContent(id);
    expect(screen.getAllByText(id)).toHaveLength(1);
    expect(screen.getByRole("region", { name: title })).toBeInTheDocument();
  });

  it("no title but a cwd: the basename is the purpose line; the header keeps the id, shown once", () => {
    const id = "coordinator-8fb2";
    const { container } = renderAgent(
      stateWith(...adhoc(id, { cwd: "/some/where/vly-review-167-spec" })),
      id,
    );
    expect(container.querySelector(".a-purpose-text")).toHaveTextContent("vly-review-167-spec");
    expect(container.querySelector(".win-bar .t-name")).toHaveTextContent(id);
    expect(container.querySelector(".a-id")).toBeNull();
    expect(screen.getAllByText(id)).toHaveLength(1);
  });

  it("a long title is one ellipsised line with the whole text on hover; a tap unwraps it", () => {
    const id = "coordinator-8fb2";
    const title = `Long ${"purpose ".repeat(24)}end`.slice(0, 120);
    const { container } = renderAgent(stateWith(...adhoc(id, { title })), id);
    const text = container.querySelector(".a-purpose-text") as HTMLElement;
    expect(text).toHaveClass("ell");
    expect(text).toHaveAttribute("title", title);
    expect(text).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(text);
    expect(container.querySelector(".a-purpose")).toHaveClass("a-purpose--open");
    expect(text).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(text);
    expect(container.querySelector(".a-purpose")).not.toHaveClass("a-purpose--open");
  });

  it("links.issue and links.pr open GitHub in a new tab", () => {
    const id = "coordinator-8fb2";
    renderAgent(
      stateWith(
        ...adhoc(id, {
          title: "#155 C13 parity — spec review",
          links: { repo: "example-org/example-repo", issue: 155, pr: 167 },
        }),
      ),
      id,
    );
    const issue = screen.getByRole("link", { name: "#155" });
    const pr = screen.getByRole("link", { name: "PR #167" });
    expect(issue).toHaveAttribute("href", "https://github.com/example-org/example-repo/issues/155");
    expect(pr).toHaveAttribute("href", "https://github.com/example-org/example-repo/pull/167");
    for (const a of [issue, pr]) {
      expect(a).toHaveAttribute("target", "_blank");
      expect(a).toHaveAttribute("rel", "noreferrer");
    }
  });
});

describe("sessions", () => {
  const ID = "coordinator-t7j0";
  const session = () =>
    adhoc(
      ID,
      {
        model_source: "harness-hook",
        workspace: "workspace:12",
        workspace_title: "Release triage",
        cwd: "/home/someone/repos/volley",
      },
      null,
    );
  const hook = (type: string, payload: Record<string, unknown>, at: number, seq: number) =>
    msg(ID, "progress", type, { source: "harness-hook", seq, hook_event: "x", ...payload }, at, {
      parent_id: null,
    });

  it("a session gets a `session` chip and its workspace title + repo as its purpose", () => {
    const { container } = renderAgent(stateWith(...session()), ID);
    const bar = container.querySelector(".win-bar") as HTMLElement;
    expect(within(bar).getByText("session")).toHaveClass("chip--session");
    expect(within(bar).queryByText("unassigned")).toBeNull();
    expect(bar.querySelector(".t-name")).toHaveTextContent("Release triage · volley");
  });

  it("the bar shows tool-call stats, no progress %; the narration line is the work log", () => {
    const state = stateWith(
      ...session(),
      hook("activity", { msg: "prompt received", tool_calls: 0 }, NOW - 60_000, 1),
      hook("activity", { msg: "Bash: gh pr checks 153", tool_calls: 7 }, NOW - 12_000, 2),
    );
    const { container } = renderAgent(state, ID);
    expect(container.querySelector(".agent-foot")).toHaveTextContent(
      "working · 7 tool calls · last 12s ago",
    );
    expect(container.querySelector('[role="progressbar"]')).toBeNull();
    expect(container.querySelector(".narr")).toHaveTextContent("Bash: gh pr checks 153");
    // Every activity line is in the feed.
    expect(container.querySelector(".feed")).toHaveTextContent("Bash: gh pr checks 153");
  });

  it("Stop's idle turns a session idle (never `working · 3.5h`); a new activity resumes it", () => {
    const idle = stateWith(
      ...session(),
      hook("activity", { msg: "Edit: src/x.ts", tool_calls: 3 }, NOW - 400_000, 1),
      hook("idle", { tool_calls: 3 }, NOW - 180_000, 2),
    );
    const { container, unmount } = renderAgent(idle, ID);
    expect(container.querySelector(".work-state")).toHaveTextContent("idle · 3m");
    expect(container.querySelector(".agent-foot")).not.toHaveTextContent("working");
    unmount();
    const again = reduceAll(idle, [
      hook("activity", { msg: "prompt received", tool_calls: 3 }, NOW - 1000, 3),
    ]);
    const { container: c2 } = renderAgent(again, ID);
    expect(c2.querySelector(".work-state")).toHaveTextContent("working");
  });

  it("a hook activity line never replaces a dispatched agent's own narration", () => {
    const id = "coordinator-8fb2";
    const state = stateWith(
      ...adhoc(id, { title: "x" }),
      msg(id, "progress", "narration", { msg: "writing the tests", progress: 40 }, NOW - 5000),
      msg(
        id,
        "progress",
        "activity",
        {
          msg: "Bash: ls",
          tool_calls: 1,
          source: "harness-hook",
          seq: 1,
          hook_event: "PreToolUse",
        },
        NOW - 1000,
      ),
    );
    const { container } = renderAgent(state, id);
    expect(container.querySelector(".narr")).toHaveTextContent("writing the tests");
    // A dispatched agent keeps its progress bar.
    expect(container.querySelector('[role="progressbar"]')).not.toBeNull();
  });
});

describe("stale progress badge", () => {
  it("renders the amber badge it is given", () => {
    const id = "coordinator-8fb2";
    const { container } = renderAgent(stateWith(...adhoc(id, { title: "x" })), id, {
      stale: "no progress reported for 10 m",
    });
    expect(container.querySelector(".chip--stale")).toHaveTextContent(
      "no progress reported for 10 m",
    );
  });
});

describe("Terminal tab", () => {
  it("a self-registered agent says why there is no terminal, never `yet`", () => {
    const id = "coordinator-8fb2";
    const { container } = renderAgent(stateWith(...adhoc(id, { title: "x" })), id);
    fireEvent.click(screen.getByRole("tab", { name: /Terminal/ }));
    const empty = container.querySelector(".term-empty") as HTMLElement;
    expect(empty).toHaveTextContent(NO_TERMINAL);
    expect(empty.textContent).not.toMatch(/\byet\b/);
  });

  it("a wave agent with no screen yet still says `no screen yet`", () => {
    const state = stateWith();
    const agent = state.agents[FIXUP];
    if (!agent) throw new Error("no fixup");
    const { container } = render(
      <AgentWindow
        agent={{ ...agent, screen: null }}
        wave={state.waves[agent.wave]}
        accent="#c4b5fd"
        frame={frame}
        now={NOW}
      />,
    );
    fireEvent.click(screen.getByRole("tab", { name: /Terminal/ }));
    expect(container.querySelector(".term-empty")).toHaveTextContent("no screen yet");
  });
});
