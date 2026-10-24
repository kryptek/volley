import { afterEach, describe, expect, it } from "vitest";
import { type WaveView, waveOutcome } from "volley-cli/setup/first-wave";
import { HELLO_WAVE, helloWaveYaml } from "volley-cli/setup/first-wave-repo";
import { DEFAULT_MODEL } from "../src/config-defaults";
import { waveStateTopic } from "../src/control";
import { type SoakEnv, WAVE, makeSoakEnv } from "./helpers/soak-env";

/**
 * `volley setup`'s test wave (volley-cli's first-wave step) on the real daemon: the wave file the
 * step writes — implement then merge_ready, `merge: auto`, the default model, one task — runs to
 * `complete` with its PR merged by the supervisor, and the step's reading of the retained state
 * (`waveOutcome`) says `done` with the PR's URL. Aedes stands in for mosquitto and the soak's
 * fleet and world for Claude Code and GitHub.
 */

let s: SoakEnv | undefined;
afterEach(async () => {
  await s?.cleanup();
  s = undefined;
});

describe("the test wave (volley setup's first-wave step), simulated", () => {
  it(
    "runs the step's hello.yaml to done: the PR merged, read back as done",
    { timeout: 120_000 },
    async () => {
      s = await makeSoakEnv({
        tasks: ["T1"],
        yaml: ({ repo, release, config }) =>
          `${helloWaveYaml({ repo, release, model: DEFAULT_MODEL, issue: 300 }).replace(
            `wave: ${HELLO_WAVE}`,
            `wave: ${WAVE}`,
          )}config: ${config}\n`,
      });
      const env = s;
      await env.until(() => env.daemon.snapshot(WAVE)?.status === "complete", "the wave complete");
      const roles = env.fleet.launches.map((a) => a.role);
      expect(roles).toEqual(["implementer"]);
      const merged = env.journal().filter((e) => e.type === "merged_by_supervisor");
      expect(merged.map((e) => e.task)).toEqual(["T1"]);

      await env.consumed();
      const retained = (await env.env.retained(waveStateTopic(WAVE))) as { payload: WaveView };
      const out = waveOutcome(retained.payload);
      expect(out?.end).toBe("done");
      expect(out?.pr).toMatch(/\/pull\/\d+$/);
    },
  );
});
