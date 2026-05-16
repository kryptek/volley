import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type TestBroker, startTestBroker } from "./helpers/aedes-broker";
import { spawnCli } from "./helpers/spawn-cli";

describe("volley CLI end-to-end (real binary)", () => {
  let tb: TestBroker;
  beforeEach(async () => {
    tb = await startTestBroker();
  });
  afterEach(async () => {
    await tb.close();
  });

  it("--help exits 0", async () => {
    const r = await spawnCli(["--help"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Usage: volley");
    expect(r.stderr).toBe("");
  });

  it("pub + wait round-trip: pub a terminal status, wait sees it, exits 0", async () => {
    // Publish a "done" status via the real binary.
    const pubR = await spawnCli([
      "pub",
      "--broker-url",
      tb.url,
      "--namespace",
      "e2e",
      "--agent-id",
      "e2e-aaaa",
      "--channel",
      "status",
      "--type",
      "done",
    ]);
    expect(pubR.exitCode).toBe(0);

    // Wait — the retained status is already done, should return immediately.
    const waitR = await spawnCli([
      "wait",
      "--broker-url",
      tb.url,
      "--namespace",
      "e2e",
      "--agent-id",
      "e2e-aaaa",
      "--timeout",
      "5",
    ]);
    expect(waitR.exitCode).toBe(0);
    expect(JSON.parse(waitR.stdout).terminal_type).toBe("done");
  });

  it("VOLLEY_BROKER_URL env overrides the default and is read by the real process", async () => {
    const r = await spawnCli(["list", "--json", "--timeout", "1"], {
      VOLLEY_BROKER_URL: tb.url,
      VOLLEY_NAMESPACE: "default",
    });
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual([]);
  });
});
