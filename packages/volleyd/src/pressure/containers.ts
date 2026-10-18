import type { Sample } from "../admission";
import type { ExecFn } from "../exec";
import { bounded, runSampler } from "./run";

/** Read-only container-runtime summary (fenced exactly). */
export const DOCKER_INFO_ARGV = ["docker", "info", "--format", "{{json .}}"] as const;

/** `docker info --format '{{json .}}'` → running containers; a down daemon is unknown. */
export function parseDockerInfo(out: string): Sample {
  let info: { ContainersRunning?: unknown; ServerErrors?: unknown };
  try {
    info = JSON.parse(out) as typeof info;
  } catch {
    return { ok: false, raw: bounded(out), error: "docker info did not print JSON" };
  }
  if (Array.isArray(info.ServerErrors) && info.ServerErrors.length > 0) {
    return { ok: false, raw: "", error: bounded(String(info.ServerErrors[0])) };
  }
  const running = info.ContainersRunning;
  return typeof running === "number" && Number.isInteger(running) && running >= 0
    ? { ok: true, value: running, raw: `ContainersRunning: ${running}` }
    : { ok: false, raw: "", error: "docker info has no ContainersRunning" };
}

export function sampleContainers(exec: ExecFn, timeoutMs: number): Promise<Sample> {
  return runSampler(exec, DOCKER_INFO_ARGV, { timeoutMs }, parseDockerInfo);
}
