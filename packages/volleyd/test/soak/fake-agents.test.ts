import { afterEach, describe, expect, it } from "vitest";
import { type SoakEnv, WAVE, makeSoakEnv } from "../helpers/soak-env";

let s: SoakEnv | undefined;
afterEach(async () => {
  if (s !== undefined) console.log(s.logs.slice(-60).join("\n"));
  await s?.cleanup();
  s = undefined;
});

describe("the fake fleet", () => {
  it("one task end to end", { timeout: 120_000 }, async () => {
    s = await makeSoakEnv({ tasks: ["T1"] });
    for (let i = 0; i < 40; i++) {
      await s.step();
      const t = s.daemon.snapshot(WAVE)?.tasks.find((x) => x.id === "T1");
      if (t?.stage === "done") break;
    }
    const j = s.journal();
    console.log(j.map((e) => `${e.seq} ${e.type} ${e.task ?? ""} ${JSON.stringify(e.data).slice(0, 160)}`).join("\n"));
    console.log("unknown", s.world.unknown.slice(0, 20));
    console.log(JSON.stringify(s.daemon.snapshot(WAVE)?.tasks, null, 1).slice(0, 2000));
    expect(s.daemon.snapshot(WAVE)?.tasks[0]?.stage).toBe("done");
  });
});
