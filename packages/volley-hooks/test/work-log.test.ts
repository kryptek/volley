import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ACTIVITY_INTERVAL_MS,
  clipLine,
  readWorkLog,
  recordActivity,
  redactSecrets,
  settleWorkLog,
  toolSummary,
} from "../src/lib/work-log";
import { tempDir } from "./helpers/tmp";

describe("redactSecrets", () => {
  it.each([
    ["mysql --password hunter2 db", "mysql --password *** db"],
    ["mysql --password=hunter2 db", "mysql --password=*** db"],
    ["gh auth login --token ghp_abc123", "gh auth login --token ***"],
    ["gh auth login --token=ghp_abc123", "gh auth login --token=***"],
    ["mysql -p hunter2 -u root", "mysql -p *** -u root"],
    ["mysql -phunter2 -u root", "mysql -p*** -u root"],
    // find's -print / -perm / -path / -prune are words, not -p plus a value
    ["find . -name x -print", "find . -name x -print"],
    ["find . -path ./x -prune -o -print0", "find . -path ./x -prune -o -print0"],
    ["find . -perm 644 -printf %p", "find . -perm 644 -printf %p"],
    ["curl 'https://x.test/a?token=abc123&b=1'", "curl 'https://x.test/a?token=***&b=1'"],
    ["export password=hunter2", "export password=***"],
    ["secret=s3cr3t ./run", "secret=*** ./run"],
    ["api_key=k1 apikey=k2", "api_key=*** apikey=***"],
    ["GH_TOKEN=abc gh pr list", "GH_TOKEN=*** gh pr list"],
    [
      "DB_PASSWORD=pw AWS_SECRET=s OPENAI_API_KEY=sk-1 cmd",
      "DB_PASSWORD=*** AWS_SECRET=*** OPENAI_API_KEY=*** cmd",
    ],
    ['curl -H "Authorization: Bearer eyJhbGc.x.y" url', 'curl -H "Authorization: Bearer ***" url'],
    ["Bearer abc.def", "Bearer ***"],
    ["git clone https://user:pass@example.test/r.git", "git clone https://***@example.test/r.git"],
    ["git clone https://tok@example.test/r.git", "git clone https://***@example.test/r.git"],
    ["mysql --password 'two words' db", "mysql --password *** db"],
  ])("%s", (input, expected) => {
    expect(redactSecrets(input)).toBe(expected);
  });

  it("leaves ordinary commands alone", () => {
    for (const s of ["gh pr checks 153", "bun run test", "git push origin main", "ls -la"]) {
      expect(redactSecrets(s)).toBe(s);
    }
  });
});

describe("clipLine", () => {
  it("keeps the first line only", () => {
    expect(clipLine("first\nsecond")).toBe("first");
  });

  it("cuts to 120 characters with an ellipsis", () => {
    const out = clipLine("x".repeat(300));
    expect(out).toHaveLength(120);
    expect(out.endsWith("…")).toBe(true);
    expect(clipLine("y".repeat(120))).toBe("y".repeat(120));
  });
});

describe("toolSummary", () => {
  const project = "/work/repo";

  it.each<[string, unknown, string]>([
    ["Bash", { command: "gh pr checks 153\necho second line" }, "Bash: gh pr checks 153"],
    ["Edit", { file_path: "/work/repo/src/x.ts" }, "Edit: src/x.ts"],
    ["Write", { file_path: "/elsewhere/y.ts" }, "Write: /elsewhere/y.ts"],
    ["Read", { file_path: "/work/repo/README.md" }, "Read: README.md"],
    ["Task", { description: "Review the diff", prompt: "long" }, "Task: Review the diff"],
    ["Agent", { description: "Explore the code" }, "Task: Explore the code"],
    ["Grep", { pattern: "redact" }, "Grep: redact"],
    ["Glob", { pattern: "**/*.ts" }, "Glob: **/*.ts"],
    ["WebFetch", { url: "https://docs.example.test/a/b?c=1" }, "WebFetch: docs.example.test"],
    ["WebSearch", { query: "mqtt retained" }, "WebSearch: mqtt retained"],
    ["mcp__volley__vol_publish", { channel: "progress" }, "vol_publish"],
    ["TodoWrite", { todos: [] }, "TodoWrite"],
    ["Bash", {}, "Bash"],
    ["WebFetch", { url: "not a url" }, "WebFetch"],
  ])("%s %j", (tool, input, expected) => {
    expect(toolSummary(tool, input, project)).toBe(expected);
  });

  it("does not relativise a sibling directory sharing the prefix", () => {
    expect(toolSummary("Edit", { file_path: "/work/repo2/x.ts" }, project)).toBe(
      "Edit: /work/repo2/x.ts",
    );
  });

  it("redacts and clips the summary", () => {
    expect(toolSummary("Bash", { command: "GH_TOKEN=abc gh pr list" }, project)).toBe(
      "Bash: GH_TOKEN=*** gh pr list",
    );
    expect(toolSummary("Bash", { command: `echo ${"z".repeat(300)}` }, project)).toHaveLength(120);
  });

  it("an unknown tool name is the summary; a non-string one is 'tool'", () => {
    expect(toolSummary(undefined, {}, project)).toBe("tool");
  });
});

describe("recordActivity (work-log.json)", () => {
  const stateDir = () => tempDir("volley-hooks-worklog-");

  it("publishes the first tick, rate-limits the next 5 s as pending (newest wins), then publishes again", async () => {
    const dir = stateDir();
    let t = 1_000_000;
    const now = () => t;
    expect(await recordActivity(dir, "Bash: a", { toolCall: true, now })).toEqual({
      publish: true,
      tool_calls: 1,
    });
    t += 1000;
    expect(await recordActivity(dir, "Bash: b", { toolCall: true, now })).toEqual({
      publish: false,
      tool_calls: 2,
    });
    t += 1000;
    expect(await recordActivity(dir, "Read: c", { toolCall: true, now })).toEqual({
      publish: false,
      tool_calls: 3,
    });
    expect(readWorkLog(dir)).toEqual({
      tool_calls: 3,
      last_published_at: 1_000_000,
      pending: "Read: c",
    });
    t = 1_000_000 + ACTIVITY_INTERVAL_MS;
    expect(await recordActivity(dir, "Edit: d", { toolCall: true, now })).toEqual({
      publish: true,
      tool_calls: 4,
    });
    // The publishing tick supersedes the pending one.
    expect(readWorkLog(dir)).toEqual({ tool_calls: 4, last_published_at: t });
  });

  it("a prompt tick does not count as a tool call", async () => {
    const dir = stateDir();
    expect(await recordActivity(dir, "prompt received", { toolCall: false, now: () => 1 })).toEqual(
      { publish: true, tool_calls: 0 },
    );
  });

  it("settleWorkLog clears pending and returns the count", async () => {
    const dir = stateDir();
    let t = 0;
    const now = () => t;
    await recordActivity(dir, "a", { toolCall: true, now });
    t = 10;
    await recordActivity(dir, "b", { toolCall: true, now });
    expect(await settleWorkLog(dir)).toBe(2);
    expect(JSON.parse(readFileSync(join(dir, "work-log.json"), "utf-8"))).toEqual({
      tool_calls: 2,
      last_published_at: 0,
    });
    expect(await settleWorkLog(stateDir())).toBe(0);
  });

  it("a corrupt work-log.json starts over", async () => {
    const dir = stateDir();
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(dir, "work-log.json"), "{nope");
    expect(readWorkLog(dir)).toEqual({ tool_calls: 0, last_published_at: null });
  });
});
