import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ControlClient } from "../src/control";
import { Daemon } from "../src/daemon";
import { findOverlaps, parseFilesSection } from "../src/overlap";
import { type TestBroker, startTestBroker } from "./helpers/aedes-broker";
import { NO_PRESSURE, NS } from "./helpers/daemon-env";
import { flushMicrotasks } from "./helpers/fake-clock";
import { tempDir } from "./helpers/tmp";

const body = (name: string) =>
  readFileSync(
    fileURLToPath(new URL(`./fixtures/issue-bodies/${name}.md`, import.meta.url)),
    "utf-8",
  );
const BODIES: Record<number, string> = { 1: body("alpha"), 2: body("beta"), 3: body("gamma") };

describe("parseFilesSection", () => {
  it("parses a ### Files list with comma lists, brace expansion, package-relative items and notes", () => {
    expect(parseFilesSection(body("alpha"))).toEqual([
      "packages/widget/src/widget.ts",
      "packages/widget/src/registry.ts",
      "packages/widget/src/commands/add.ts",
      "packages/widget/src/commands/remove.ts",
      "packages/widget/test/widget.test.ts",
      "packages/widget/README.md",
    ]);
  });

  it("parses a `Files:` line list and normalises ./ prefixes", () => {
    expect(parseFilesSection(body("beta"))).toEqual([
      "packages/widget/src/registry.ts",
      "docs/registry.md",
    ]);
  });

  it("parses a ## Files section with * bullets and trailing prose", () => {
    expect(parseFilesSection(body("gamma"))).toEqual([
      "docs/gamma.md",
      "packages/other/src/index.ts",
    ]);
  });

  it("returns [] when the body has no Files section", () => {
    expect(parseFilesSection("# Title\n\nJust prose mentioning `a/b.ts`.\n")).toEqual([]);
  });
});

describe("findOverlaps", () => {
  const alpha = { id: "X", files: parseFilesSection(body("alpha")) };
  it("two task file lists sharing a path → one warning listing the path and both wave/task ids", () => {
    const w = findOverlaps(
      { wave: "w2", tasks: [{ id: "Y", files: parseFilesSection(body("beta")) }] },
      [{ wave: "w1", tasks: [alpha] }],
    );
    expect(w).toEqual([
      {
        paths: ["packages/widget/src/registry.ts"],
        tasks: [
          { wave: "w2", task: "Y" },
          { wave: "w1", task: "X" },
        ],
      },
    ]);
  });

  it("no shared path → no warning", () => {
    const w = findOverlaps(
      { wave: "w2", tasks: [{ id: "Z", files: parseFilesSection(body("gamma")) }] },
      [{ wave: "w1", tasks: [alpha] }],
    );
    expect(w).toEqual([]);
  });

  it("matches a glob or a directory prefix against a concrete path", () => {
    const w = findOverlaps(
      { wave: "b", tasks: [{ id: "T", files: ["pkg/test/fixtures/*.md", "docs/"] }] },
      [
        {
          wave: "a",
          tasks: [{ id: "S", files: ["pkg/test/fixtures/x.md", "docs/guide/intro.md"] }],
        },
      ],
    );
    expect(w).toHaveLength(1);
    expect(w[0]?.paths).toEqual(["pkg/test/fixtures/x.md", "docs/guide/intro.md"]);
  });
});

describe("overlap warning at submit (daemon)", () => {
  let broker: TestBroker;
  let home: string;
  let daemon: Daemon;
  let client: ControlClient;
  const wave = (id: string, issue: number) => `wave: ${id}
repo: example-org/example-repo
release_branch: release/${id}
model: claude-opus-5-5
pipeline: [implement, merge_ready]
tasks:
  ${id === "w1" ? "X" : "Y"}: { issue: ${issue} }
`;

  beforeEach(async () => {
    broker = await startTestBroker();
    home = tempDir("volleyd-overlap-");
    daemon = await Daemon.start({
      brokerUrl: broker.url,
      namespace: NS,
      home,
      tickMs: 0,
      protocolVersion: 4,
      pressure: NO_PRESSURE,
      issueBody: async (_repo, issue) => BODIES[issue] ?? null,
    });
    client = await ControlClient.connect(broker.url, NS);
    expect((await client.request("run", { wave_yaml: wave("w1", 1) })).warnings ?? []).toEqual([]);
  });
  afterEach(async () => {
    await client.close();
    await daemon.stop();
    await broker.close();
  });

  it("journals one overlap warning and returns a line for the run output", async () => {
    const res = await client.request("run", { wave_yaml: wave("w2", 2) });
    expect(res.error).toBeUndefined();
    expect(res.warnings).toEqual([
      "overlap: w2/Y and w1/X both touch packages/widget/src/registry.ts",
    ]);
    const alarms = daemon
      .journalEvents("w2")
      .filter((e) => e.type === "alarm_raised" && e.data.alarm === "overlap_warning");
    expect(alarms).toHaveLength(1);
    expect(alarms[0]?.task).toBe("Y");
    expect(alarms[0]?.data).toEqual({
      alarm: "overlap_warning",
      paths: ["packages/widget/src/registry.ts"],
      tasks: [
        { wave: "w2", task: "Y" },
        { wave: "w1", task: "X" },
      ],
    });
    // Issue-body files are advisory: journaled on task_queued, never merged into the wave
    // definition (whose `files` drive the scheduler's same-file ordering).
    expect(daemon.record("w2")?.wave?.tasks.Y?.files).toEqual([]);
    const queued = daemon.journalEvents("w2").find((e) => e.type === "task_queued");
    expect(queued?.data.issue_files).toEqual([
      "packages/widget/src/registry.ts",
      "docs/registry.md",
    ]);
    const submitted = daemon.journalEvents("w2").find((e) => e.type === "wave_submitted");
    expect(
      (submitted?.data.wave as { tasks: Record<string, { files: string[] }> }).tasks.Y?.files,
    ).toEqual([]);
  });

  it("remembers journaled issue files across a restart", async () => {
    await daemon.stop();
    daemon = await Daemon.start({
      brokerUrl: broker.url,
      namespace: NS,
      home,
      tickMs: 0,
      protocolVersion: 4,
      pressure: NO_PRESSURE,
      // Issue 1's body is unreachable now: only the journal still knows w1/X's files.
      issueBody: async (_repo, issue) => (issue === 2 ? (BODIES[2] ?? null) : null),
    });
    const res = await client.request("run", { wave_yaml: wave("w2", 2) });
    expect(res.warnings).toEqual([
      "overlap: w2/Y and w1/X both touch packages/widget/src/registry.ts",
    ]);
  });

  it("fetches issue bodies off the serial queue: other control ops answer meanwhile", async () => {
    await daemon.stop();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let fetched!: () => void;
    const reached = new Promise<void>((r) => {
      fetched = r;
    });
    daemon = await Daemon.start({
      brokerUrl: broker.url,
      namespace: NS,
      home,
      tickMs: 0,
      protocolVersion: 4,
      pressure: NO_PRESSURE,
      issueBody: async (_repo, issue) => {
        fetched();
        await gate;
        return BODIES[issue] ?? null;
      },
    });
    const run = client.request("run", { wave_yaml: wave("w2", 2) }, { timeoutMs: 5000 });
    await reached;
    // The fetch is still parked, yet a status query is answered.
    const status = await client.request("status", {}, { timeoutMs: 1000 });
    expect(status.ok).toBe(true);
    expect(daemon.snapshot("w2")).toBeNull();
    release();
    expect((await run).warnings).toHaveLength(1);
    expect(daemon.snapshot("w2")?.tasks.map((t) => t.id)).toEqual(["Y"]);
  });

  it("a run whose issue fetch finishes after stop() journals nothing", async () => {
    await daemon.stop();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let fetched!: () => void;
    const reached = new Promise<void>((r) => {
      fetched = r;
    });
    const late = await Daemon.start({
      brokerUrl: broker.url,
      namespace: NS,
      home,
      tickMs: 0,
      protocolVersion: 4,
      pressure: NO_PRESSURE,
      issueBody: async (_repo, issue) => {
        fetched();
        await gate;
        return BODIES[issue] ?? null;
      },
    });
    void client.request("run", { wave_yaml: wave("w4", 2) }, { timeoutMs: 1000 }).catch(() => {});
    await reached;
    await late.stop();
    release();
    // The fetch resolves into a stopped daemon: what it would set off is done once that is idle.
    await late.settled();
    await flushMicrotasks();
    expect(existsSync(join(home, "waves", "w4"))).toBe(false);
    daemon = await Daemon.start({
      brokerUrl: broker.url,
      namespace: NS,
      home,
      tickMs: 0,
      protocolVersion: 4,
      pressure: NO_PRESSURE,
    });
  });

  it("no overlap → no warning and nothing journaled", async () => {
    const res = await client.request("run", { wave_yaml: wave("w3", 3) });
    expect(res.warnings ?? []).toEqual([]);
    expect(
      daemon
        .journalEvents("w3")
        .filter((e) => e.type === "alarm_raised" && e.data.alarm === "overlap_warning"),
    ).toEqual([]);
  });
});
