import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ExecFn, ExecOptions, ExecResult } from "../src/exec";
import { assertAllowed } from "../src/fence";
import { countApiSignals, isApiSignal } from "../src/pressure/api-signals";
import { CI_QUEUE_ARGV, parseCiQueue, sampleCiQueue } from "../src/pressure/ci-queue";
import { CMUX_PING_ARGV, sampleCmuxPing } from "../src/pressure/cmux";
import { DOCKER_INFO_ARGV, parseDockerInfo, sampleContainers } from "../src/pressure/containers";
import {
  MEMORY_PRESSURE_ARGV,
  SYSCTL_ARGV,
  parseMemoryPressure,
  parseSysctlPressure,
  sampleMemory,
} from "../src/pressure/memory";

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/pressure/${name}`, import.meta.url), "utf-8");

const ok = (stdout: string): ExecResult => ({ code: 0, stdout, stderr: "", timedOut: false });

/** A fake exec answering by program name; records every call. */
function fakeExec(answers: Record<string, ExecResult | Error>) {
  const calls: { argv: readonly string[]; opts: ExecOptions | undefined }[] = [];
  const exec: ExecFn = async (argv, opts) => {
    calls.push({ argv, opts });
    assertAllowed(argv); // samplers only ever run fenced commands
    const a = answers[argv[0] ?? ""];
    if (a === undefined || a instanceof Error) throw a ?? new Error(`spawn ${argv[0]} ENOENT`);
    return a;
  };
  return { exec, calls };
}

describe("memory pressure", () => {
  it("parses sysctl -n output and the named form", () => {
    expect(parseSysctlPressure(fixture("sysctl-critical.txt"))).toMatchObject({
      ok: true,
      value: 4,
    });
    expect(parseSysctlPressure(fixture("sysctl-named-normal.txt"))).toMatchObject({
      ok: true,
      value: 1,
    });
    expect(
      parseSysctlPressure("sysctl: unknown oid 'kern.memorystatus_vm_pressure_level'").ok,
    ).toBe(false);
  });

  it("maps memory_pressure's free percentage to a level (fallback)", () => {
    const s = parseMemoryPressure(fixture("memory-pressure.txt"));
    expect(s).toMatchObject({ ok: true, value: 4 });
    expect(parseMemoryPressure("System-wide memory free percentage: 15%\n").value).toBe(2);
    expect(parseMemoryPressure("System-wide memory free percentage: 62%\n").value).toBe(1);
    expect(parseMemoryPressure("nothing useful").ok).toBe(false);
  });

  it("samples sysctl first and falls back to memory_pressure", async () => {
    const f = fakeExec({
      sysctl: { code: 1, stdout: "", stderr: "unknown oid", timedOut: false },
      memory_pressure: ok(fixture("memory-pressure.txt")),
    });
    expect(await sampleMemory(f.exec, 1000)).toMatchObject({ ok: true, value: 4 });
    expect(f.calls.map((c) => c.argv)).toEqual([SYSCTL_ARGV, MEMORY_PRESSURE_ARGV]);
  });

  it("is unknown (not ok) when neither tool exists", async () => {
    const s = await sampleMemory(fakeExec({}).exec, 1000);
    expect(s.ok).toBe(false);
    expect(s.error).toContain("ENOENT");
  });
});

describe("containers", () => {
  it("parses docker info JSON: running containers", () => {
    expect(parseDockerInfo(fixture("docker-info.json"))).toMatchObject({ ok: true, value: 7 });
  });

  it("a docker daemon that is down is unknown, with the server error", () => {
    const s = parseDockerInfo(fixture("docker-info-down.json"));
    expect(s.ok).toBe(false);
    expect(s.error).toContain("Cannot connect to the Docker daemon");
  });

  it("samples with the fenced docker info argv", async () => {
    const f = fakeExec({ docker: ok(fixture("docker-info.json")) });
    expect(await sampleContainers(f.exec, 1000)).toMatchObject({ ok: true, value: 7 });
    expect(f.calls[0]?.argv).toEqual(DOCKER_INFO_ARGV);
  });
});

describe("CI queue", () => {
  it("parses gh api total_count", () => {
    expect(parseCiQueue(fixture("gh-runs-queued.json"))).toMatchObject({ ok: true, value: 4 });
    expect(parseCiQueue("HTTP 401: Bad credentials").ok).toBe(false);
  });

  it("runs gh api in the wave's repo so {owner}/{repo} resolve there", async () => {
    const f = fakeExec({ gh: ok(fixture("gh-runs-queued.json")) });
    expect(await sampleCiQueue(f.exec, "/tmp/some-repo", 1000)).toMatchObject({ value: 4 });
    expect(f.calls[0]?.argv).toEqual(CI_QUEUE_ARGV);
    expect(f.calls[0]?.opts?.cwd).toBe("/tmp/some-repo");
  });
});

describe("cmux ping", () => {
  it("measures wall time of a successful ping", async () => {
    let t = 1000;
    const exec: ExecFn = async () => {
      t += 250;
      return ok("pong\n");
    };
    expect(await sampleCmuxPing(exec, 3000, () => t)).toMatchObject({ ok: true, value: 250 });
  });

  it("a ping that times out is a measurement (the socket stopped answering), not unknown", async () => {
    let t = 0;
    const exec: ExecFn = async (_argv, opts) => {
      t += opts?.timeoutMs ?? 0;
      return { code: 143, stdout: "", stderr: "", timedOut: true };
    };
    const s = await sampleCmuxPing(exec, 3000, () => t);
    expect(s).toMatchObject({ ok: true, value: 3000 });
  });

  it("no cmux binary is unknown", async () => {
    const s = await sampleCmuxPing(fakeExec({}).exec, 3000);
    expect(s.ok).toBe(false);
  });

  it("uses the fenced argv", async () => {
    const f = fakeExec({ cmux: ok("pong") });
    await sampleCmuxPing(f.exec, 3000);
    expect(f.calls[0]?.argv).toEqual(CMUX_PING_ARGV);
  });
});

describe("API overload signals", () => {
  const env = (type: string, payload: Record<string, unknown>) => ({ type, payload });

  it("matches quota auto-resume notifications and overload / rate-limit idle texts", () => {
    expect(
      isApiSignal(env("awaiting_input", { notification_type: "quota_auto_resume_scheduled" })),
    ).toBe(true);
    expect(isApiSignal(env("idle", { text: "API Error: 529 Overloaded" }))).toBe(true);
    expect(isApiSignal(env("idle", { text: "You've hit your usage limit" }))).toBe(true);
    expect(isApiSignal(env("idle", { text: "Rate limit reached, retrying" }))).toBe(true);
    expect(isApiSignal(env("idle", { text: "All tests pass." }))).toBe(false);
    expect(isApiSignal(env("awaiting_input", { notification_type: "idle_prompt" }))).toBe(false);
    expect(isApiSignal(env("heartbeat", { text: "overloaded" }))).toBe(false);
  });

  it("counts only signals inside the window", () => {
    const now = 1_000_000;
    const times = [now - 400_000, now - 299_000, now - 10_000, now];
    expect(countApiSignals(times, now, 300)).toMatchObject({ ok: true, value: 3 });
  });
});

describe("the fence allows exactly the read-only sampler argvs", () => {
  it("allows each sampler argv", () => {
    for (const argv of [SYSCTL_ARGV, MEMORY_PRESSURE_ARGV, DOCKER_INFO_ARGV, CI_QUEUE_ARGV]) {
      expect(() => assertAllowed(argv)).not.toThrow();
    }
  });

  it("still denies anything else from those programs", () => {
    for (const argv of [
      ["sysctl", "-w", "kern.memorystatus_vm_pressure_level=4"],
      ["sysctl", "kern.memorystatus_vm_pressure_level=4"],
      ["memory_pressure", "-l", "critical"],
      ["memory_pressure", "-S", "-l", "warn"],
      ["docker", "info"],
      ["docker", "run", "alpine"],
      ["docker", "rm", "-f", "x"],
    ]) {
      expect(() => assertAllowed(argv), argv.join(" ")).toThrow(/FENCE_DENIED/);
    }
  });
});
