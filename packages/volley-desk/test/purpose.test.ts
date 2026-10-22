import { describe, expect, it } from "vitest";
import { UNASSIGNED, isSession } from "../src/store/reducer";
import type { AgentView, FeedEntry, WaveView } from "../src/store/types";
import { purposeOf } from "../src/windows/agent/purpose";

function agent(over: Partial<AgentView> = {}): AgentView {
  return {
    id: "coordinator-8fb2",
    namespace: "default",
    parentId: "coordinator-ab12",
    wave: UNASSIGNED,
    task: null,
    role: null,
    registered: true,
    registry: null,
    model: null,
    status: null,
    progress: null,
    narration: null,
    heartbeat: null,
    lastSeen: 0,
    attention: null,
    attentionObserved: false,
    feed: [],
    screen: null,
    bornAt: null,
    ...over,
  };
}

const reg = (extra: Record<string, unknown>) => ({
  capabilities: [],
  started_at: "2026-10-19T10:00:00Z",
  ...extra,
});

function wave(over: Record<string, unknown> = {}): WaveView {
  return {
    id: "w1",
    state: {
      repo: "example-org/example-repo",
      tasks: [{ id: "T3", issue: 42, stage: "implement", agents: {} }],
      spec: {
        version: 1,
        tasks: { T3: { issue: 42, title: "Fix the login redirect", after: [] } },
      },
      ...over,
    },
  } as unknown as WaveView;
}

function progress(msg: string, at: number, source?: string): FeedEntry {
  return {
    topic: "volley/default/coordinator-8fb2/progress",
    receivedAt: at,
    envelope: {
      schema_version: "0.1",
      agent_id: "coordinator-8fb2",
      channel: "progress",
      type: "narration",
      wall_time: new Date(at).toISOString(),
      payload: { msg, ...(source ? { source } : {}) },
    },
  } as unknown as FeedEntry;
}

describe("purposeOf", () => {
  const GITHUB = {
    slug: "example-org/example-repo",
    url: "https://github.com/example-org/example-repo",
  };
  const PR = { number: 7, url: "https://github.com/example-org/example-repo/pull/7" };
  const withPr = (over: Record<string, unknown> = {}) =>
    wave({
      tasks: [{ id: "T3", issue: 42, stage: "implement", agents: {}, pr: PR }],
      ...over,
    });

  it("a wave agent: `<task> · <title>`, the issue linked through the wave's github", () => {
    const p = purposeOf(
      agent({ wave: "w1", task: "T3", role: "implementer" }),
      withPr({ github: GITHUB }),
    );
    expect(p.label).toBe("T3 · Fix the login redirect");
    expect(p.source).toBe("wave");
    expect(p.links).toEqual([
      {
        text: "#42",
        href: "https://github.com/example-org/example-repo/issues/42",
        label: "Issue #42 on GitHub",
      },
      { text: "PR #7", href: PR.url, label: "PR #7 on GitHub" },
    ]);
  });

  it("a wave with no github: the issue unlinked even when repo looks like a slug", () => {
    const p = purposeOf(agent({ wave: "w1", task: "T3", role: "implementer" }), wave());
    expect(p.links).toEqual([{ text: "#42", href: null, label: "Issue #42" }]);
  });

  it("a GitHub Enterprise host: the issue derived from its url, still named on GitHub", () => {
    const p = purposeOf(
      agent({ wave: "w1", task: "T3", role: "implementer" }),
      wave({ github: { slug: "org/repo", url: "https://github.example.com/org/repo" } }),
    );
    expect(p.links).toEqual([
      {
        text: "#42",
        href: "https://github.example.com/org/repo/issues/42",
        label: "Issue #42 on GitHub",
      },
    ]);
  });

  it("a wave with no github still links a PR through its own url", () => {
    const p = purposeOf(agent({ wave: "w1", task: "T3", role: "implementer" }), withPr());
    expect(p.links).toEqual([
      { text: "#42", href: null, label: "Issue #42" },
      { text: "PR #7", href: PR.url, label: "PR #7 on GitHub" },
    ]);
  });

  it("a PR whose url is not http(s): `PR #n` shown unlinked, not dropped", () => {
    const p = purposeOf(
      agent({ wave: "w1", task: "T3", role: "implementer" }),
      wave({
        tasks: [
          {
            id: "T3",
            issue: 42,
            stage: "implement",
            agents: {},
            pr: { number: 7, url: "javascript:alert(1)" },
          },
        ],
      }),
    );
    expect(p.links).toEqual([
      { text: "#42", href: null, label: "Issue #42" },
      { text: "PR #7", href: null, label: "PR #7" },
    ]);
  });

  it.each([0, 1.5, -3])("a PR number that is not a positive integer (%p): no PR link", (n) => {
    const p = purposeOf(
      agent({ wave: "w1", task: "T3", role: "implementer" }),
      wave({
        tasks: [
          {
            id: "T3",
            issue: 42,
            stage: "implement",
            agents: {},
            pr: { number: n, url: PR.url },
          },
        ],
      }),
    );
    expect(p.links.map((l) => l.text)).toEqual(["#42"]);
  });

  it("an ad-hoc agent: its registered title; links resolve against links.repo", () => {
    const p = purposeOf(
      agent({
        registry: reg({
          title: "#155 C13 parity — spec review",
          links: {
            repo: "example-org/example-repo",
            issue: 155,
            pr: "https://github.com/example-org/example-repo/pull/167",
          },
        }),
      }),
      undefined,
    );
    expect(p.label).toBe("#155 C13 parity — spec review");
    expect(p.source).toBe("registered");
    expect(p.links).toEqual([
      {
        text: "#155",
        href: "https://github.com/example-org/example-repo/issues/155",
        label: "Issue #155 on GitHub",
      },
      {
        text: "PR #167",
        href: "https://github.com/example-org/example-repo/pull/167",
        label: "PR #167 on GitHub",
      },
    ]);
  });

  it("a bare number with no repo is shown but not clickable; a non-http URL is dropped", () => {
    const p = purposeOf(
      agent({ registry: reg({ title: "x", links: { issue: 7, pr: "javascript:alert(1)" } }) }),
      undefined,
    );
    expect(p.links).toEqual([{ text: "#7", href: null, label: "Issue #7" }]);
  });

  it("no title: the cwd basename", () => {
    const p = purposeOf(
      agent({ registry: reg({ cwd: "/some/where/vly-review-167-spec/" }) }),
      undefined,
    );
    expect(p.label).toBe("vly-review-167-spec");
    expect(p.source).toBe("cwd");
  });

  it("no title, no cwd: the earliest progress message the agent itself sent", () => {
    const p = purposeOf(
      agent({
        narration: "running the tests",
        feed: [
          progress("Bash: ls", 1, "harness-hook"),
          progress("reading the plan", 2),
          progress("running the tests", 3),
        ],
      }),
      undefined,
    );
    expect(p.label).toBe("reading the plan");
    expect(p.source).toBe("narration");
  });

  it("nothing at all: the agent id, never an empty string", () => {
    const p = purposeOf(agent({ registry: reg({ title: "   ", cwd: "/" }) }), undefined);
    expect(p.label).toBe("coordinator-8fb2");
    expect(p.source).toBe("id");
  });

  it("a session: its workspace title and repo basename", () => {
    const a = agent({
      parentId: null,
      registry: reg({
        model_source: "harness-hook",
        workspace: "workspace:12",
        workspace_title: "Release triage",
        cwd: "/path/to/home/repos/volley",
      }),
    });
    const p = purposeOf(a, undefined);
    expect(p.label).toBe("Release triage · volley");
    expect(p.source).toBe("session");
  });

  it("a session with no workspace title falls back to its cwd basename", () => {
    const a = agent({
      parentId: null,
      registry: reg({ model_source: "harness-hook", cwd: "/path/to/home/repos/volley" }),
    });
    expect(purposeOf(a, undefined)).toMatchObject({ label: "volley", source: "cwd" });
  });

  it("a registered title wins over a session's workspace title", () => {
    const a = agent({
      parentId: null,
      registry: reg({
        model_source: "harness-hook",
        title: "Dispatching #169",
        workspace_title: "w",
      }),
    });
    expect(purposeOf(a, undefined)).toMatchObject({
      label: "Dispatching #169",
      source: "registered",
    });
  });
});

describe("isSession", () => {
  const hookReg = reg({ model_source: "harness-hook", workspace: "workspace:3" });
  it("a hook-registered agent with no parent and no wave is a session", () => {
    expect(isSession(agent({ parentId: null, registry: hookReg }))).toBe(true);
  });
  it("a dispatched agent (it has a parent) is not", () => {
    expect(isSession(agent({ registry: hookReg }))).toBe(false);
  });
  it("a wave agent is not", () => {
    expect(isSession(agent({ parentId: null, wave: "w1", task: "T3", registry: hookReg }))).toBe(
      false,
    );
  });
  it("a self-reported model_source is not a hook's: not a session", () => {
    expect(
      isSession(agent({ parentId: null, registry: reg({ model_source: "self-reported" }) })),
    ).toBe(false);
  });
  it("an agent that registered itself (no model_source) is not", () => {
    expect(isSession(agent({ parentId: null, registry: reg({}) }))).toBe(false);
  });
});
