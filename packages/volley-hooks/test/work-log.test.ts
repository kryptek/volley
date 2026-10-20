import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ACTIVITY_INTERVAL_MS,
  clipLine,
  flushPending,
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
    ["git log --format='Author: %an'", "git log --format='Author: %an'"],
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
    // Generic credential flags: any --*password / --*token / --*secret / --*key
    ["llm --api-key abc123 run", "llm --api-key *** run"],
    ["vault --secret abc run", "vault --secret *** run"],
    ["tool --access-token=x1 go", "tool --access-token=*** go"],
    ["tool --client-secret 's p' go", "tool --client-secret *** go"],
    // curl user:password
    ["curl -u admin:hunter2 https://x.test", "curl -u admin:*** https://x.test"],
    ["curl --user admin:hunter2 https://x.test", "curl --user admin:*** https://x.test"],
    ["curl --user=admin:hunter2 https://x.test", "curl --user=admin:*** https://x.test"],
    ["curl -u 'admin:two words' https://x.test", "curl -u 'admin:***' https://x.test"],
    // Credential-looking headers
    ['curl -H "X-Api-Key: abc123" https://x.test', 'curl -H "X-Api-Key: ***" https://x.test'],
    ["curl -H 'X-Auth-Token: x' https://x.test", "curl -H 'X-Auth-Token: ***' https://x.test"],
    ['curl -H "Authorization: Bearer x" u', 'curl -H "Authorization: Bearer ***" u'],
    ['curl -H "Authorization: Basic dXNlcg==" u', 'curl -H "Authorization: Basic ***" u'],
    ['curl -H "Cookie: session=x; theme=dark" u', 'curl -H "Cookie: ***" u'],
    ['curl -H "Proxy-Authorization: Basic abc" u', 'curl -H "Proxy-Authorization: Basic ***" u'],
    [`echo '{"api_key": "abc"}'`, `echo '{"api_key": "***"}'`],
    // Token shapes, wherever they appear
    ["echo AKIAIOSFODNN7EXAMPLE", "echo ***"],
    ["echo ASIAIOSFODNN7EXAMPLE done", "echo *** done"],
    ["git remote add o ghp_0123456789abcdefghijABCD", "git remote add o ***"],
    ["echo gho_0123456789abcdefghijABCD", "echo ***"],
    ["echo github_pat_11ABCDEFG0123456789_abcdefghijk", "echo ***"],
    ["run sk-ant-api03-abcdefghij0123456789 now", "run *** now"],
    ["run sk-proj-abcdefghij0123456789", "run ***"],
    ["notify xoxb-1234567890-abcdefghij", "notify ***"],
    ["check eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc_DEF-123 ok", "check *** ok"],
    [
      "echo '-----BEGIN RSA PRIVATE KEY----- MIIEabc -----END RSA PRIVATE KEY-----' > k",
      "echo '***' > k",
    ],
    ["printf '-----BEGIN OPENSSH PRIVATE KEY-----MIIEabc", "printf '***"],
    // name / value after a set / config command
    [
      "aws configure set aws_secret_access_key wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      "aws configure set aws_secret_access_key ***",
    ],
    [
      "aws configure set aws_secret_access_key AKIAIOSFODNN7EXAMPLE",
      "aws configure set aws_secret_access_key ***",
    ],
    ["git config --global user.signingkey ABCDEF12", "git config --global user.signingkey ***"],
    ["export PASSWORD=hunter2", "export PASSWORD=***"],
  ])("%s", (input, expected) => {
    expect(redactSecrets(input)).toBe(expected);
  });

  it("leaves ordinary commands alone", () => {
    for (const s of [
      "gh pr checks 153",
      "bun run test",
      "git push origin main",
      "ls -la",
      'git commit -m "fix key handling"',
      "ls ~/.ssh",
      "ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519",
      "grep -rn token src",
      "git log --oneline",
      "bun run setup",
      "task-runner-for-the-whole-project",
    ]) {
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

  it("maps paths under HOME outside the project to ~/…", () => {
    const home = "/home/someone";
    expect(toolSummary("Read", { file_path: "/home/someone/.ssh/id_rsa" }, project, home)).toBe(
      "Read: ~/.ssh/id_rsa",
    );
    expect(toolSummary("Bash", { command: "cat /home/someone/.aws/config" }, project, home)).toBe(
      "Bash: cat ~/.aws/config",
    );
    // A sibling home sharing the prefix is not HOME.
    expect(toolSummary("Read", { file_path: "/home/someone2/x" }, project, home)).toBe(
      "Read: /home/someone2/x",
    );
    // Inside the project (itself under HOME) stays project-relative.
    expect(
      toolSummary("Edit", { file_path: "/home/someone/repo/src/a.ts" }, "/home/someone/repo", home),
    ).toBe("Edit: src/a.ts");
    // No usable HOME: unchanged.
    expect(toolSummary("Read", { file_path: "/home/someone/.ssh/id_rsa" }, project, "/")).toBe(
      "Read: /home/someone/.ssh/id_rsa",
    );
  });

  it("an unknown tool name is the summary; a non-string one is 'tool'", () => {
    expect(toolSummary(undefined, {}, project)).toBe("tool");
  });
});

describe("recordActivity (work-log.json)", () => {
  const stateDir = () => tempDir("volley-hooks-worklog-");
  const A = "session-a";
  const B = "session-b";

  it("publishes the first tick, rate-limits the next 5 s as pending (newest wins), then publishes again", async () => {
    const dir = stateDir();
    let t = 1_000_000;
    const now = () => t;
    const rec = (msg: string) => recordActivity(dir, msg, { toolCall: true, sessionId: A, now });
    expect(await rec("Bash: a")).toEqual({ publish: true, tool_calls: 1 });
    t += 1000;
    expect(await rec("Bash: b")).toEqual({ publish: false, tool_calls: 2 });
    t += 1000;
    expect(await rec("Read: c")).toEqual({ publish: false, tool_calls: 3 });
    expect(readWorkLog(dir)).toEqual({
      session_id: A,
      tool_calls: 3,
      last_published_at: 1_000_000,
      pending: "Read: c",
    });
    t = 1_000_000 + ACTIVITY_INTERVAL_MS;
    expect(await rec("Edit: d")).toEqual({ publish: true, tool_calls: 4 });
    // The publishing tick supersedes the pending one.
    expect(readWorkLog(dir)).toEqual({ session_id: A, tool_calls: 4, last_published_at: t });
  });

  it("a prompt tick does not count as a tool call", async () => {
    const dir = stateDir();
    expect(
      await recordActivity(dir, "prompt received", { toolCall: false, sessionId: A, now: () => 1 }),
    ).toEqual({ publish: true, tool_calls: 0 });
  });

  it("counts per session: another session_id starts a fresh count and a fresh window", async () => {
    const dir = stateDir();
    let t = 0;
    const now = () => t;
    for (const msg of ["a1", "a2", "a3"]) {
      await recordActivity(dir, msg, { toolCall: true, sessionId: A, now });
      t += 100;
    }
    // Inside A's window, but B has never published: it may, and its count is its own.
    expect(await recordActivity(dir, "b1", { toolCall: true, sessionId: B, now })).toEqual({
      publish: true,
      tool_calls: 1,
    });
    expect(readWorkLog(dir)).toEqual({ session_id: B, tool_calls: 1, last_published_at: t });
  });

  it("two sessions running side by side each keep their own count and window", async () => {
    const dir = stateDir();
    let t = 0;
    const now = () => t;
    const a = (msg: string) => recordActivity(dir, msg, { toolCall: true, sessionId: A, now });
    const b = (msg: string) => recordActivity(dir, msg, { toolCall: true, sessionId: B, now });
    expect(await a("a1")).toEqual({ publish: true, tool_calls: 1 });
    expect(await b("b1")).toEqual({ publish: true, tool_calls: 1 });
    t += 100;
    expect(await a("a2")).toEqual({ publish: false, tool_calls: 2 });
    expect(await b("b2")).toEqual({ publish: false, tool_calls: 2 });
    expect(await a("a3")).toEqual({ publish: false, tool_calls: 3 });
    expect(readWorkLog(dir, A)).toMatchObject({ tool_calls: 3, pending: "a3" });
    expect(readWorkLog(dir, B)).toMatchObject({ tool_calls: 2, pending: "b2" });
  });

  it("drops sessions untouched for a week", async () => {
    const dir = stateDir();
    await recordActivity(dir, "old", { toolCall: true, sessionId: A, now: () => 0 });
    const week = 7 * 24 * 3600_000;
    await recordActivity(dir, "new", { toolCall: true, sessionId: B, now: () => week + 1 });
    const file = JSON.parse(readFileSync(join(dir, "work-log.json"), "utf-8"));
    expect(Object.keys(file.sessions)).toEqual([B]);
  });

  it("a log written without a session_id counts as another session's", async () => {
    const dir = stateDir();
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(dir, "work-log.json"), JSON.stringify({ tool_calls: 7 }));
    expect(await recordActivity(dir, "x", { toolCall: true, sessionId: A, now: () => 1 })).toEqual({
      publish: true,
      tool_calls: 1,
    });
  });

  it("settleWorkLog clears pending and returns the session's count (0 for another session)", async () => {
    const dir = stateDir();
    let t = 0;
    const now = () => t;
    await recordActivity(dir, "a", { toolCall: true, sessionId: A, now });
    t = 10;
    await recordActivity(dir, "b", { toolCall: true, sessionId: A, now });
    expect(await settleWorkLog(dir, B)).toBe(0);
    expect(readWorkLog(dir, A)).toMatchObject({ session_id: A, pending: "b" });
    expect(await settleWorkLog(dir, A)).toBe(2);
    expect(readWorkLog(dir, A)).toEqual({ session_id: A, tool_calls: 2, last_published_at: 0 });
    expect(await settleWorkLog(stateDir(), A)).toBe(0);
  });

  it("a corrupt work-log.json starts over", async () => {
    const dir = stateDir();
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(dir, "work-log.json"), "{nope");
    expect(readWorkLog(dir)).toEqual({ tool_calls: 0, last_published_at: null });
  });
});

describe("flushPending (the newest line of a window, at the next slot)", () => {
  const A = "session-a";

  async function burst(dir: string, now: () => number) {
    for (const msg of ["Bash: one", "Bash: two", "Bash: three"]) {
      await recordActivity(dir, msg, { toolCall: true, sessionId: A, now });
    }
  }

  it("inside the window: nothing to publish, pending kept", async () => {
    const dir = tempDir("volley-hooks-worklog-");
    await burst(dir, () => 1000);
    expect(
      await flushPending(dir, { sessionId: A, now: () => 1000 + ACTIVITY_INTERVAL_MS - 1 }),
    ).toBeNull();
    expect(readWorkLog(dir).pending).toBe("Bash: three");
  });

  it("after the window: returns the pending line with the current count, clears it, restarts the window", async () => {
    const dir = tempDir("volley-hooks-worklog-");
    await burst(dir, () => 1000);
    const later = 1000 + ACTIVITY_INTERVAL_MS;
    expect(await flushPending(dir, { sessionId: A, now: () => later })).toEqual({
      msg: "Bash: three",
      tool_calls: 3,
    });
    expect(readWorkLog(dir)).toEqual({ session_id: A, tool_calls: 3, last_published_at: later });
    // Flushed once only.
    expect(await flushPending(dir, { sessionId: A, now: () => later + 99_999 })).toBeNull();
  });

  it("another session's pending line is never flushed", async () => {
    const dir = tempDir("volley-hooks-worklog-");
    await burst(dir, () => 1000);
    expect(await flushPending(dir, { sessionId: "session-b", now: () => 999_999 })).toBeNull();
    expect(readWorkLog(dir).pending).toBe("Bash: three");
  });

  it("no pending line: null", async () => {
    const dir = tempDir("volley-hooks-worklog-");
    expect(await flushPending(dir, { sessionId: A })).toBeNull();
  });
});
