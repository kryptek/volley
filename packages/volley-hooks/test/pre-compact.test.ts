import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type TestBroker, startTestBroker } from "./helpers/aedes-broker";
import { fixture, makeWorkdir, runHook } from "./helpers/hooks";

let broker: TestBroker;

beforeEach(async () => {
  broker = await startTestBroker();
});

afterEach(async () => {
  await broker.close();
});

describe("pre-compact", () => {
  it("snapshots STEERING.md to .volley/steering.snapshot.md", async () => {
    const dir = makeWorkdir({ agent_id: "w1-t1-implementer-1", broker_url: broker.url });
    const body = "# Volley steering\n\n## 1 steering id-1\n<!-- volley state=live -->\nhello\n";
    writeFileSync(join(dir, ".volley", "STEERING.md"), body);
    const run = await runHook("pre-compact", fixture("pre-compact.json", dir), { cwd: dir });
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toBe("");
    expect(readFileSync(join(dir, ".volley", "steering.snapshot.md"), "utf-8")).toBe(body);
  });

  it("does nothing to the snapshot when there is no STEERING.md", async () => {
    const dir = makeWorkdir({ agent_id: "w1-t1-implementer-1", broker_url: broker.url });
    const run = await runHook("pre-compact", fixture("pre-compact.json", dir), { cwd: dir });
    expect(run.exitCode).toBe(0);
    expect(existsSync(join(dir, ".volley", "steering.snapshot.md"))).toBe(false);
  });
});
