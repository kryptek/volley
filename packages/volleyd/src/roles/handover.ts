import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DAEMON_DEFAULTS } from "../config-defaults";
import { remoteVolleyArgv } from "../fence";
import type { RemoteHost, RemoteHostSpec } from "../hosts/ssh-tmux";
import type { RoleDeps } from "./deps";
import type { MoveRecord, MoveStep } from "./engine";
import { lastLine, waitForStatus } from "./health";
import {
  type Handover,
  OLD_STEPS,
  handoverFile,
  newSteps,
  oldMachineSpec,
  withSupervisor,
} from "./plan-supervisor";

/**
 * The second half of a supervisor move (SPEC §4.6.24), run by the new supervisor: at its start it
 * finds the move's `handover.json` (restored from the bundle), takes the move on under the same
 * id, publishing on the same moves topic, and runs the steps the old supervisor left it: its own
 * `working` status, the old machine re-paired (as a tmux machine over ssh, `tunnel: none`: the
 * broker stays there), then the roles record. A re-pairing that fails ends the move `done` with
 * a warning in its step line: the owner re-pairs by hand.
 */

export interface HandoverDeps {
  /** This supervisor's own retained status (`volley/<ns>/volleyd/status`), or null. */
  ownStatus: () => Promise<string | null>;
  /** A pairing code bound to machine `name` (peers.ts `mintFor`). */
  mintCode: (name: string, by: string) => string;
  /** A remote host for a machine that is not configured (yet). */
  remoteAt: (spec: RemoteHostSpec) => RemoteHost;
}

/** The hand-overs addressed to this machine that no supervisor took on yet. */
export function pendingHandovers(home: string, localName: string): Handover[] {
  const root = join(home, "roles");
  if (!existsSync(root)) return [];
  const out: Handover[] = [];
  for (const id of readdirSync(root)) {
    const file = handoverFile(home, id);
    if (!existsSync(file)) continue;
    try {
      const h = JSON.parse(readFileSync(file, "utf-8")) as Handover;
      if (h.role === "supervisor" && h.to === localName && h.continued !== true && h.move_id === id)
        out.push(h);
    } catch {}
  }
  return out;
}

/** Mark a hand-over taken on, so a restart never runs it twice. */
export function markContinued(home: string, h: Handover): void {
  writeFileSync(
    handoverFile(home, h.move_id),
    `${JSON.stringify({ ...h, continued: true }, null, 2)}\n`,
    { mode: 0o600 },
  );
}

/** The record the move resumes from: the old supervisor's steps all `ok`. */
export function resumeRecord(h: Handover, by: string, now: Date): MoveRecord {
  const steps = [
    ...OLD_STEPS.map((id) => ({ id, title: id, where: h.from })),
    ...newSteps(h.from, h.to),
  ];
  const was = h.record?.steps ?? [];
  return {
    move_id: h.move_id,
    role: "supervisor",
    from: h.from,
    to: h.to,
    status: "running",
    steps: steps.map((s) => ({
      id: s.id,
      title: was.find((w) => w.id === s.id)?.title ?? s.title,
      where: s.where,
      status: (OLD_STEPS as readonly string[]).includes(s.id) ? "ok" : "pending",
    })),
    since: now.toISOString(),
    by,
    started_at: h.record?.started_at ?? now.toISOString(),
  };
}

/** Every step of the move, the old supervisor's as done placeholders, the rest with runners. */
export function resumeSteps(d: RoleDeps, x: HandoverDeps, h: Handover): MoveStep[] {
  const { from, to } = h;
  const rec = resumeRecord(h, h.by, d.now());
  const done: MoveStep[] = rec.steps
    .filter((s) => (OLD_STEPS as readonly string[]).includes(s.id))
    .map((s) => ({ ...s, detail: s.id, run: async () => undefined }));
  const shown = newSteps(from, to);
  const step = (id: string) => shown.find((s) => s.id === id) as MoveStep;
  return [
    ...done,
    {
      ...step("working"),
      run: () => waitForStatus(x.ownStatus, "working", `the supervisor on ${to}`, d.sleep),
    },
    {
      ...step("repair"),
      run: async () => {
        const by = `the hand-over from ${from}`;
        const byHand = `re-pair it by hand: \`volley peer invite\` on ${to}, then \`volley peer join <code> --to ${h.new_target} --name ${from} --tunnel none\` on ${from}`;
        if (h.old_target === undefined)
          return `warning: ${to} does not know how to reach ${from} over ssh: ${byHand}`;
        const code = x.mintCode(from, by);
        const host = x.remoteAt(oldMachineSpec(h));
        // The old machine's own checkout, never a `volley` on its PATH (#550).
        const argv = remoteVolleyArgv(host.spec.volley_dir, [
          "peer",
          "join",
          code,
          "--to",
          h.new_target,
          "--name",
          from,
          "--target",
          h.old_target,
          "--tunnel",
          "none",
        ]);
        const r = await host
          .run([{ argv, cwd: host.spec.volley_dir }], {
            timeoutMs: DAEMON_DEFAULTS.role_step_timeout_ms,
          })
          .catch((e: unknown) => ({ code: -1, stdout: "", stderr: String(e), timedOut: false }));
        return r.code === 0
          ? `${from} is a paired machine (tmux over ssh)`
          : `warning: re-pairing ${from} failed (${lastLine(r)}): ${byHand}`;
      },
    },
    {
      ...step("record"),
      run: async () => {
        await d.writeRoles(withSupervisor(d.roles, to, h.by, d.now()));
        return `the roles record names ${to} as the supervisor`;
      },
    },
  ];
}
