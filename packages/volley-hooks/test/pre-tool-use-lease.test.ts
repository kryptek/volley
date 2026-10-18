import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { VolleyBroker } from "volley-mcp/broker";
import { leaseFor, shellQuote, wrapCommand } from "../src/hooks/pre-tool-use-lease";
import { type TestBroker, startTestBroker } from "./helpers/aedes-broker";
import {
  PACKAGE_ROOT,
  connectClient,
  fixture,
  makeWorkdir,
  publishEnvelope,
  runHook,
} from "./helpers/hooks";

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
    expect(cmd).toContain(" lease run --pool backend-it --holder w1-t1-implementer-1 ");
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

  it("ignores tools other than Bash", async () => {
    expect(await hook("mvn verify", { tool_name: "Read" })).toBeNull();
  });

  it("the wrapped command really runs the original through the shell", () => {
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

describe("leaseFor", () => {
  it("picks the first pool whose match regex hits; skips invalid regexes", () => {
    const pools = { bad: { match: ["("] }, ...POOLS };
    expect(leaseFor("npm run build && npm test", pools)).toBe("build");
    expect(leaseFor("./mvnw -q -Pit verify", pools)).toBeNull();
    expect(leaseFor("mvn -q verify", pools)).toBe("backend-it");
    expect(leaseFor("echo hi", pools)).toBeNull();
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
