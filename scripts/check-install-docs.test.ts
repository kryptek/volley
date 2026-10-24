import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Docs guard for the one-command install: the stale install instructions the install epic's
 * inventory found never come back in a tracked Markdown file. A `claude mcp add-json` with a
 * password in it (`volley setup` registers the server with no secret), a `brew services start
 * mosquitto` prerequisite (setup installs and starts the broker, on Linux too), the
 * `example-dispatch` namespace (everything defaults to `default`), and a model id written out
 * (it goes stale: Volley's default is `DEFAULT_MODEL` in `packages/volleyd/src/config-defaults.ts`).
 * It also pins the Quickstart to the one command, and `docs/INSTALL.md` to every installer flag.
 */

const ROOT = join(import.meta.dir, "..");

/** The command the README prints; it never changes (the script defaults to the latest tag). */
const ONE_COMMAND =
  "curl -fsSL https://raw.githubusercontent.com/kryptek/volley/main/install.sh | sh";

/** The changelog and its fragments record what changed, stale forms included. */
const HISTORY = (f: string) => f === "CHANGELOG.md" || f.startsWith("changes/");

/** Files that may name a model id: dated measurements and test data, not instructions. */
const MODEL_IDS_ALLOWED = (f: string) =>
  f === "packages/volleyd/docs/claude-accounts-spike.md" || /(^|\/)test\/fixtures\//.test(f);

const MODEL_ID =
  /\bclaude-(?:opus|sonnet|haiku|fable)-\d[\w.-]*|\bclaude-\d(?:[-.]\d)?-(?:opus|sonnet|haiku)\b/g;

/** A JSON `"VOLLEY_AUTH_PASSWORD": …` value, or a `<… password …>` placeholder. */
const PASSWORD_IN_REGISTRATION = /"VOLLEY_AUTH_PASSWORD"\s*:|<[^<>\n]*password[^<>\n]*>/i;

/**
 * The text a `claude mcp add-json` at `index` belongs to: its fenced code block when it is in
 * one, else its paragraph.
 */
function instructionAround(text: string, index: number): string {
  const fences = [...text.matchAll(/^\s*```/gm)].map((m) => m.index ?? 0);
  for (let i = 0; i + 1 < fences.length; i += 2) {
    const open = fences[i] as number;
    const close = fences[i + 1] as number;
    if (open < index && index < close) return text.slice(open, close);
  }
  const start = text.lastIndexOf("\n\n", index);
  const end = text.indexOf("\n\n", index);
  return text.slice(start < 0 ? 0 : start, end < 0 ? text.length : end);
}

const lineOf = (text: string, index: number) => text.slice(0, index).split("\n").length;

/** Every `file:line: why` the stale forms leave in `text`. */
function staleForms(file: string, text: string): string[] {
  if (HISTORY(file)) return [];
  const hits: string[] = [];
  const at = (index: number, why: string) => hits.push(`${file}:${lineOf(text, index)}: ${why}`);
  for (const m of text.matchAll(/claude mcp add-json/g)) {
    if (PASSWORD_IN_REGISTRATION.test(instructionAround(text, m.index ?? 0)))
      at(
        m.index ?? 0,
        "claude mcp add-json with a password (volley setup registers it, no secret)",
      );
  }
  for (const m of text.matchAll(/brew services start mosquitto/g))
    at(m.index ?? 0, "brew services start mosquitto (volley setup starts the broker)");
  for (const m of text.matchAll(/example-dispatch/g))
    at(m.index ?? 0, "the example-dispatch namespace (the namespace is default)");
  if (!MODEL_IDS_ALLOWED(file)) {
    for (const m of text.matchAll(MODEL_ID))
      at(m.index ?? 0, `model id ${m[0]} (name DEFAULT_MODEL in config-defaults.ts instead)`);
  }
  return hits;
}

/** The `--flags` install.sh's usage block lists. */
function installerFlags(script: string): string[] {
  const usage = script.match(/cat <<'EOF'\n([\s\S]*?)\nEOF/)?.[1] ?? "";
  const options = usage.split("Options:")[1] ?? "";
  return [...options.matchAll(/^ {2}(?:-\w, )?(--[a-z][a-z-]*)/gm)].map((m) => m[1] as string);
}

/** The README's Quickstart section: from its heading to the next `## `. */
function quickstart(readme: string): string {
  const start = readme.search(/^## Quickstart/m);
  if (start < 0) return "";
  const next = readme.slice(start + 1).search(/^## /m);
  return next < 0 ? readme.slice(start) : readme.slice(start, start + 1 + next);
}

function tracked(pattern: string): string[] {
  const ls = Bun.spawnSync(["git", "ls-files", "-z", "--", pattern], { cwd: ROOT });
  if (ls.exitCode !== 0) throw new Error(`git ls-files failed: ${ls.stderr.toString()}`);
  return ls.stdout.toString().split("\0").filter(Boolean);
}

const read = (f: string) => readFileSync(join(ROOT, f), "utf8");

describe("staleForms", () => {
  test("a registration with a password placeholder, in a code block or inline", () => {
    const block = [
      "```sh",
      "claude mcp add-json -s user volley '{",
      '  "env": { "VOLLEY_AUTH_PASSWORD": "<coordinator password from step 2>" }',
      "}'",
      "```",
    ].join("\n");
    expect(staleForms("a.md", block)).toEqual([
      "a.md:2: claude mcp add-json with a password (volley setup registers it, no secret)",
    ]);
    const inline = "Run `claude mcp add-json -s user volley '{…<the coordinator's password>…}'`.";
    expect(staleForms("a.md", inline)).toHaveLength(1);
  });

  test("a registration without a secret, or prose about one, passes", () => {
    const block = [
      "```sh",
      "claude mcp add-json -s user volley '{",
      '  "env": { "VOLLEY_AGENT_ID": "coordinator", "VOLLEY_AUTH_DIR": "/path/to/auth" }',
      "}'",
      "```",
      "",
      "An entry with a `VOLLEY_AUTH_PASSWORD` of your own is left as is.",
    ].join("\n");
    expect(staleForms("a.md", block)).toEqual([]);
    const prose =
      "registered (`claude mcp add-json -s user volley`); the fence refuses an env naming a password";
    expect(staleForms("a.md", prose)).toEqual([]);
  });

  test("the broker prerequisite, the old namespace and model ids", () => {
    const text = [
      "- A running broker: `brew services start mosquitto`.",
      'vol_list_agents({ namespace: "example-dispatch" })',
      "model: claude-opus-4-7, or claude-3-5-sonnet, or claude-sonnet-5",
    ].join("\n");
    expect(staleForms("a.md", text)).toEqual([
      "a.md:1: brew services start mosquitto (volley setup starts the broker)",
      "a.md:2: the example-dispatch namespace (the namespace is default)",
      "a.md:3: model id claude-opus-4-7 (name DEFAULT_MODEL in config-defaults.ts instead)",
      "a.md:3: model id claude-3-5-sonnet (name DEFAULT_MODEL in config-defaults.ts instead)",
      "a.md:3: model id claude-sonnet-5 (name DEFAULT_MODEL in config-defaults.ts instead)",
    ]);
    expect(staleForms("a.md", "brew install mosquitto; claude-code; --model opus")).toEqual([]);
  });

  test("the changelog keeps history; dated records and fixtures keep model ids", () => {
    const text = "`brew services start mosquitto` and claude-opus-4-7";
    expect(staleForms("CHANGELOG.md", text)).toEqual([]);
    expect(staleForms("changes/468.docs.md", text)).toEqual([]);
    expect(staleForms("packages/volleyd/test/fixtures/briefs/x.md", text)).toHaveLength(1);
    expect(staleForms("packages/volleyd/docs/claude-accounts-spike.md", "claude-opus-4-7")).toEqual(
      [],
    );
  });
});

describe("installerFlags", () => {
  test("reads every option from the usage block", () => {
    const script = [
      "usage() {",
      "  cat <<'EOF'",
      "Usage: install.sh [options]          (piped: curl … | sh -s -- [options])",
      "Options:",
      "  --version vX.Y.Z   Install this tag",
      "  --no-setup         Stop before setup",
      "                     --continued lines are not flags",
      "  -h, --help         Show this help",
      "EOF",
      "}",
    ].join("\n");
    expect(installerFlags(script)).toEqual(["--version", "--no-setup", "--help"]);
  });
});

describe("the install docs", () => {
  test("no tracked Markdown file carries a stale install instruction", () => {
    const offenders = tracked("*.md").flatMap((f) => {
      try {
        return staleForms(f, read(f));
      } catch {
        return []; // deleted in the working tree
      }
    });
    expect(offenders).toEqual([]);
  });

  test("the Quickstart is the one command, on Linux and macOS, linking docs/INSTALL.md", () => {
    const qs = quickstart(read("README.md"));
    expect(qs).toContain(ONE_COMMAND);
    expect(qs).toContain("docs/INSTALL.md");
    expect(qs).toMatch(/Linux/);
    expect(qs).toMatch(/macOS/);
    // macOS-only wording with no Linux counterpart
    expect(qs).not.toMatch(/Cmd-Q|~\/\.zshrc/);
    // the manual path is docs/INSTALL.md's, not a second Quickstart
    expect(qs).not.toContain("claude mcp add-json");
  });

  test("docs/INSTALL.md documents every installer flag and the one command", () => {
    const install = read("docs/INSTALL.md");
    expect(install).toContain(ONE_COMMAND);
    const flags = installerFlags(read("install.sh"));
    expect(flags).toContain("--uninstall");
    expect(flags.filter((f) => !install.includes(`\`${f}`))).toEqual([]);
  });

  test("the per-step confirm is quoted as setup prints it, and says `y`", () => {
    // packages/volley-cli/src/commands/setup.ts: `Apply this change (…)?` / `Apply these <n> changes (…)?`
    for (const f of ["README.md", "docs/INSTALL.md", "docs/SMOKE-v0.11.md"]) {
      const text = read(f);
      expect({ f, stale: /Apply these changes\b/.test(text) }).toEqual({ f, stale: false });
      expect({ f, quoted: text.includes("Apply these <n> changes (") }).toEqual({
        f,
        quoted: true,
      });
    }
    expect(quickstart(read("README.md"))).toMatch(/type `y`/);
  });

  test("docs/SMOKE-v0.11.md part A is written: steps with Pass lines and a results block", () => {
    const smoke = read("docs/SMOKE-v0.11.md");
    const partA = smoke.slice(smoke.indexOf("## Part A"), smoke.indexOf("## Part B"));
    expect(partA).not.toMatch(/Written by #468\.\s*$/m);
    expect(partA).toContain(ONE_COMMAND);
    expect(partA).toContain("**Pass:**");
    expect(partA).toContain("### A. Results");
  });
});
