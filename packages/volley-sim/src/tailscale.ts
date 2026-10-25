import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Env, isSimulated, passThrough, simHome } from "./env";
import type { Out } from "./gh";
import { appendUnknown } from "./world";

/**
 * The fake Tailscale CLI, for `volley setup`'s Network step (`--network tailscale`): `version`,
 * `status --json` (signed in, as `sim-machine.example.ts.net` at 100.64.0.2), `ip -4`, and `up`,
 * which prints its sign-in link once (exit 1, still waiting, as a sign-in nobody finished yet)
 * and exits 0 on the next call. `funnel`, `serve` and any other argv exit 1 with `unknown argv`
 * and are appended to `$VOLLEY_SIM_HOME/unknown.jsonl`: Volley never runs them.
 */

export const TAILSCALE_VERSION = "1.76.1";
export const SIM_DNS_NAME = "sim-machine.example.ts.net.";
export const SIM_ADDRESS = "100.64.0.2";
export const SIM_LOGIN_URL = "https://login.tailscale.com/a/simulated";

/** Marks the first `tailscale up` (its link printed): `$VOLLEY_SIM_HOME/tailscale-up`. */
export const UP_MARKER = "tailscale-up";

const ok = (stdout = ""): Out => ({ code: 0, stdout, stderr: "" });

/** Answer one `tailscale` argv (without `tailscale`). */
export function runTailscale(argv: string[], ctx: { cwd: string; env: Env }): Out {
  const home = simHome(ctx.env);
  const line = argv.join(" ");
  if (line === "version") {
    return ok(`${TAILSCALE_VERSION}\n  tailscale commit: simulated\n  go version: go1.23\n`);
  }
  if (line === "status --json") {
    return ok(
      `${JSON.stringify(
        {
          Version: TAILSCALE_VERSION,
          BackendState: "Running",
          Self: { DNSName: SIM_DNS_NAME, TailscaleIPs: [SIM_ADDRESS, "fd7a:115c:a1e0::2"] },
        },
        null,
        2,
      )}\n`,
    );
  }
  if (line === "ip -4") return ok(`${SIM_ADDRESS}\n`);
  if (line === "up") {
    const marker = join(home, UP_MARKER);
    if (existsSync(marker)) return ok();
    mkdirSync(home, { recursive: true });
    writeFileSync(marker, "");
    return { code: 1, stdout: "", stderr: `\nTo authenticate, visit:\n\n\t${SIM_LOGIN_URL}\n\n` };
  }
  appendUnknown(home, ["tailscale", ...argv], ctx.cwd);
  return { code: 1, stdout: "", stderr: `unknown argv: tailscale ${line}\n` };
}

/** `bin/tailscale`: answer under `VOLLEY_SIMULATED=1`, else run the real tailscale. */
export function main(argv: string[] = process.argv.slice(2)): number {
  if (!isSimulated()) return passThrough("tailscale", argv);
  const r = runTailscale(argv, { cwd: process.cwd(), env: process.env });
  if (r.stdout !== "") process.stdout.write(r.stdout);
  if (r.stderr !== "") process.stderr.write(r.stderr);
  return r.code;
}
