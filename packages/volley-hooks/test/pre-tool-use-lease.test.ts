import { execFile, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { VolleyBroker } from "volley-mcp/broker";
import { leaseCli, leaseFor, shellQuote, wrapCommand } from "../src/hooks/pre-tool-use-lease";
import { type TestBroker, startTestBroker } from "./helpers/aedes-broker";
import {
  PACKAGE_ROOT,
  connectClient,
  fixture,
  makeWorkdir,
  publishEnvelope,
  publishRegistry,
  runHook,
} from "./helpers/hooks";
import { tempDir } from "./helpers/tmp";

const AGENT = "w1-t1-implementer-1";
const POOLS = {
  "backend-it": { capacity: 3, match: ["mvn .*verify", "mvn .*test"] },
  build: { capacity: 2, match: ["npm run build", "vite build"] },
};

let broker: TestBroker;
let client: VolleyBroker;
let dir: string;

beforeEach(async () => {
  broker = await startTestBroker();
  client = await connectClient(broker.url);
  dir = makeWorkdir({ agent_id: AGENT, namespace: "ns", broker_url: broker.url });
  await publishEnvelope(
    client,
    "volley/_waves/_config",
    {
      agentId: "volleyd",
      parentId: null,
      channel: "_waves/_config",
      type: "config",
      payload: { version: 1, lease_pools: POOLS },
    },
    { qos: 1, retain: true },
  );
});

afterEach(async () => {
  await client.disconnect();
  await broker.close();
});

async function hook(command: string, extra: Record<string, unknown> = {}) {
  const input = fixture("pre-tool-use-bash.json", dir, {
    tool_input: { command, description: "x" },
    ...extra,
  });
  const run = await runHook("pre-tool-use-lease", input, { cwd: dir });
  expect(run.exitCode).toBe(0);
  return run.stdout.trim() === ""
    ? null
    : (JSON.parse(run.stdout) as {
        hookSpecificOutput: {
          hookEventName: string;
          updatedInput?: { command: string; description?: string };
          additionalContext?: string;
          permissionDecision?: string;
        };
      });
}

describe("pre-tool-use-lease hook", () => {
  it("wraps a matching command in `volley lease run` via updatedInput", async () => {
    const out = await hook("cd x && mvn -q verify");
    expect(out?.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    const cmd = out?.hookSpecificOutput.updatedInput?.command ?? "";
    expect(cmd).toContain(" lease run --pool 'backend-it' --holder 'w1-t1-implementer-1' ");
    expect(cmd).toContain(`--broker-url ${shellQuote(broker.url)}`);
    expect(cmd).toContain(`--project-dir ${shellQuote(dir)}`);
    expect(cmd.endsWith(`-- "\${SHELL:-/bin/sh}" -c 'cd x && mvn -q verify'`)).toBe(true);
    // The other tool_input fields are kept; the permission decision is left alone.
    expect(out?.hookSpecificOutput.updatedInput?.description).toBe("x");
    expect(out?.hookSpecificOutput.permissionDecision).toBeUndefined();
    expect(out?.hookSpecificOutput.additionalContext).toContain(
      "command queued for a backend-it lease",
    );
  });

  it("leaves an already-wrapped command unchanged (empty output)", async () => {
    const wrapped = wrapCommand("mvn verify", {
      pool: "backend-it",
      holder: AGENT,
      brokerUrl: broker.url,
      projectDir: dir,
      cli: "volley",
    });
    expect(await hook(wrapped)).toBeNull();
    expect(await hook("volley lease run --pool build -- vite build")).toBeNull();
  });

  it("a non-matching command → empty output", async () => {
    expect(await hook("ls -la && git status")).toBeNull();
  });

  it("a command that only mentions a heavy one (heredoc, message) → empty output", async () => {
    expect(await hook("cat <<'EOF' > notes.md\nrun mvn -q verify later\nEOF")).toBeNull();
    expect(await hook('git commit -m "fix: mvn verify flake"')).toBeNull();
  });

  it("ignores tools other than Bash", async () => {
    expect(await hook("mvn verify", { tool_name: "Read" })).toBeNull();
  });

  it("coordinator mode: the wrapper asks the CLI for coordinator credentials, not the cwd's identity file", async () => {
    const coordDir = makeWorkdir();
    await publishRegistry(client, "coordinator-ab12", "default", {
      capabilities: [],
      cwd: coordDir,
      started_at: "2026-10-18T10:00:00.000Z",
    });
    const input = fixture("pre-tool-use-bash.json", coordDir, {
      tool_input: { command: "mvn -q verify", description: "x" },
    });
    const run = await runHook("pre-tool-use-lease", input, {
      cwd: coordDir,
      env: {
        VOLLEY_HOOKS_COORDINATOR: "1",
        VOLLEY_BROKER_URL: broker.url,
        VOLLEY_HOOKS_STATE_DIR: tempDir("volley-hooks-state-"),
      },
    });
    expect(run.exitCode).toBe(0);
    const cmd = (
      JSON.parse(run.stdout) as { hookSpecificOutput: { updatedInput: { command: string } } }
    ).hookSpecificOutput.updatedInput.command;
    expect(cmd).toContain(" lease run --pool 'backend-it' --holder 'coordinator-ab12' ");
    expect(cmd).toContain(" --coordinator ");
    expect(cmd).not.toContain("--project-dir");
  });

  it("never puts a pool name from the broker into the command unless it is a valid pool id", async () => {
    await publishEnvelope(
      client,
      "volley/_waves/_config",
      {
        agentId: "volleyd",
        parentId: null,
        channel: "_waves/_config",
        type: "config",
        payload: {
          version: 2,
          lease_pools: { "x;touch pwned;#": { capacity: 1, match: ["mvn"] } },
        },
      },
      { qos: 1, retain: true },
    );
    expect(await hook("mvn -q verify")).toBeNull();
    expect(existsSync(join(dir, "pwned"))).toBe(false);
  });

  it("the full wrapped command runs end to end: no volleyd → the CLI fails open and runs the original", async () => {
    const original = `printf '%s' "it's" && echo " ok"`;
    const wrapped = wrapCommand(original, {
      pool: "build",
      holder: AGENT,
      brokerUrl: broker.url,
      cli: leaseCli({}),
    });
    // Async: the Aedes broker runs in this process and must keep serving the CLI.
    const { stdout, stderr } = await promisify(execFile)("sh", ["-c", wrapped], {
      env: { ...process.env, SHELL: "/bin/sh" },
    });
    expect(stdout).toBe("it's ok\n");
    expect(stderr).toContain("no live volleyd; running without a lease");
  });

  it("quotes the original so the shell runs it verbatim", () => {
    const original = `printf '%s' "it's" && echo " ok"`;
    const wrapped = wrapCommand(original, {
      pool: "p",
      holder: AGENT,
      brokerUrl: "mqtt://127.0.0.1:1",
      cli: "volley",
    });
    // Replace the wrapper with `echo`-free passthrough: everything after ` -- ` is the argv.
    const argv = wrapped.slice(wrapped.indexOf(" -- ") + 4);
    expect(execFileSync("sh", ["-c", argv], { env: { SHELL: "/bin/sh" } }).toString()).toBe(
      "it's ok\n",
    );
  });
});

describe("leaseFor / wrapCommand", () => {
  it("skips a pool whose name is not a valid pool id", () => {
    expect(
      leaseFor("mvn verify", { "a b": { match: ["mvn"] }, "$(x)": { match: ["mvn"] } }),
    ).toBeNull();
    expect(leaseFor("mvn verify", { "Bad;": { match: ["mvn"] }, ok: { match: ["mvn"] } })).toBe(
      "ok",
    );
  });

  it("shell-quotes the pool and holder", () => {
    const w = wrapCommand("true", { pool: "p", holder: "h", brokerUrl: "u", cli: "volley" });
    expect(w).toContain("--pool 'p' --holder 'h' ");
  });

  it("picks the first pool whose match regex hits; skips invalid regexes", () => {
    const pools = { bad: { match: ["("] }, ...POOLS };
    expect(leaseFor("npm run build && npm test", pools)).toBe("build");
    expect(leaseFor("./mvnw -q -Pit verify", pools)).toBeNull();
    expect(leaseFor("mvn -q verify", pools)).toBe("backend-it");
    expect(leaseFor("echo hi", pools)).toBeNull();
  });

  it("matches the commands the shell would execute, not heredoc, comment or message text", () => {
    const pools = { "js-tests": { match: ["bun run test", "vitest"] } };
    expect(leaseFor("cat <<'EOF' > notes.md\nrun bun run test later\nEOF", pools)).toBeNull();
    expect(leaseFor('git commit -m "fix: bun run test flake"', pools)).toBeNull();
    expect(leaseFor("# bun run test", pools)).toBeNull();
    expect(leaseFor('echo "then bun run test"', pools)).toBeNull();
    expect(leaseFor("bun run test && echo done", pools)).toBe("js-tests");
    expect(leaseFor("cd packages/x && bunx vitest run", pools)).toBe("js-tests");
    expect(leaseFor('bash -c "bun run test"', pools)).toBe("js-tests");
  });
});

describe("settings template", () => {
  it("registers the lease hook on PreToolUse with matcher Bash", async () => {
    const settings = JSON.parse(
      (await import("node:fs")).readFileSync(
        join(PACKAGE_ROOT, "settings.volley-hooks.json"),
        "utf-8",
      ),
    ) as { hooks: Record<string, { matcher?: string; hooks: { command: string }[] }[]> };
    const entry = settings.hooks.PreToolUse?.[0];
    expect(entry?.matcher).toBe("Bash");
    expect(entry?.hooks[0]?.command).toContain("src/hooks/pre-tool-use-lease.ts");
    expect(existsSync(join(PACKAGE_ROOT, "src", "hooks", "pre-tool-use-lease.ts"))).toBe(true);
  });
});
