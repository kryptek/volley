import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ControlClient } from "../src/control";
import { Daemon } from "../src/daemon";
import { findOverlaps, parseFilesSection } from "../src/overlap";
import { type TestBroker, startTestBroker } from "./helpers/aedes-broker";
import { NS } from "./helpers/daemon-env";

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
    home = mkdtempSync(join(tmpdir(), "volleyd-overlap-"));
    daemon = await Daemon.start({
      brokerUrl: broker.url,
      namespace: NS,
      home,
      tickMs: 0,
      issueBody: async (_repo, issue) => BODIES[issue] ?? null,
    });
    client = await ControlClient.connect(broker.url, NS);
    expect((await client.request("run", { wave_yaml: wave("w1", 1) })).warnings ?? []).toEqual([]);
  });
  afterEach(async () => {
    await client.close();
    await daemon.stop();
    await broker.close();
    rmSync(home, { recursive: true, force: true });
  });

  it("journals one overlap warning and returns a line for the run output", async () => {
    const res = await client.request("run", { wave_yaml: wave("w2", 2) });
    expect(res.error).toBeUndefined();
    expect(res.warnings).toEqual([
      "overlap: w2/Y and w1/X both touch packages/widget/src/registry.ts",
    ]);
    const alarms = daemon.journalEvents("w2").filter((e) => e.type === "alarm_raised");
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
    // Issue-body files become the task's files hint (the scheduler's same-file ordering uses it).
    expect(daemon.record("w2")?.wave?.tasks.Y?.files).toEqual([
      "packages/widget/src/registry.ts",
      "docs/registry.md",
    ]);
  });

  it("no overlap → no warning and nothing journaled", async () => {
    const res = await client.request("run", { wave_yaml: wave("w3", 3) });
    expect(res.warnings ?? []).toEqual([]);
    expect(daemon.journalEvents("w3").filter((e) => e.type === "alarm_raised")).toEqual([]);
  });
});
