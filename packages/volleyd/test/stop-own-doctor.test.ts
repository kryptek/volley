import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DoctorReport } from "../src/machines";
import { type DaemonEnv, makeDaemonEnv } from "./helpers/daemon-env";
import { GREEN_DOCTOR } from "./helpers/fake-host";

/**
 * The own doctor runs beside the queue (`volley peer doctor`, a child process for seconds). A
 * stop that left it running let the child outlive the daemon and keep writing under its $HOME.
 */
describe("stop() and an own doctor still running", () => {
  let env: DaemonEnv;
  beforeEach(async () => {
    env = await makeDaemonEnv();
  });
  afterEach(async () => {
    await env.cleanup();
  });

  it("aborts the run and resolves only once it has settled", async () => {
    let started!: () => void;
    const running = new Promise<void>((r) => {
      started = r;
    });
    let signal: AbortSignal | undefined;
    let settled = false;
    const daemon = await env.start({
      fleet: {
        localDoctor: (_repo, s) => {
          signal = s;
          started();
          // Like exec: the run ends only when its child is gone, a turn after the abort.
          return new Promise<DoctorReport | null>((resolve) => {
            s?.addEventListener("abort", () =>
              setImmediate(() => {
                settled = true;
                resolve(GREEN_DOCTOR);
              }),
            );
          });
        },
      },
    });
    void daemon.tick();
    await running;
    expect(signal?.aborted).toBe(false);
    await daemon.stop();
    expect(signal?.aborted).toBe(true);
    expect(settled).toBe(true);
  });
});
