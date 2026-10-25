import { describe, expect, it } from "vitest";
import { renderHandoff } from "../src/coordinator/handoff";

const base = {
  name: "coord-test",
  machine: "box-a",
  dir: "/path/to/home/.volley/coordinator",
  waves: [
    { id: "w1", repo: "example-org/example-repo", done: 3, total: 5 },
    { id: "w2", repo: "example-org/other", done: 0, total: 2 },
  ],
  inbox: [{ id: "d-w1-d-abc", title: "Reviewers disagree · w1/T1" }],
};

describe("renderHandoff (SPEC §4.6.25)", () => {
  it("names the role, the machine, the waves and the open items", () => {
    expect(renderHandoff(base)).toBe(
      [
        "You are the coordinator `coord-test` of this Volley fleet, running on `box-a` in `/path/to/home/.volley/coordinator` (repos under `repos/`).",
        "Running waves: `w1` (example-org/example-repo, 3/5 tasks done); `w2` (example-org/other, 0/2 tasks done).",
        "Open needs-you items: `d-w1-d-abc` Reviewers disagree · w1/T1.",
        "Use `/volley` and `/volley-issues` as usual.",
      ].join("\n"),
    );
  });

  it("none, and the previous session when known", () => {
    expect(
      renderHandoff({ ...base, waves: [], inbox: [], previousSessionId: "coordinator-ab12" }),
    ).toBe(
      [
        "You are the coordinator `coord-test` of this Volley fleet, running on `box-a` in `/path/to/home/.volley/coordinator` (repos under `repos/`).",
        "Running waves: none.",
        "Open needs-you items: none.",
        "The previous coordinator session was `coordinator-ab12` (resume it with `/resume coordinator-ab12` if you need the detail).",
        "Use `/volley` and `/volley-issues` as usual.",
      ].join("\n"),
    );
  });
});
