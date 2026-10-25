import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Env, isSimulated, passThrough, simHome } from "./env";
import type { Out } from "./gh";
import { appendUnknown } from "./world";

/**
 * The fake Tailscale CLI, for `volley setup`'s Network step (`--network tailscale`): `version`,
 * `status --json` (signed in, as `sim-machine.example.ts.net` at 100.64.0.2), `ip -4`, and `up`,
 * which prints its sign-in link once (exit 1, still waiting, as a sign-in nobody finished yet)
 * and exits 0 on the next call. The Desk's serves (`volley desk install --tailscale`): `serve
 * --bg --https=<port> http://127.0.0.1:<port>`, `serve status --json` and `serve --https=<port>
 * off`, kept in `$VOLLEY_SIM_HOME/tailscale-serve.json`. `funnel`, any other `serve` and any
 * other argv exit 1 with `unknown argv` and are appended to `$VOLLEY_SIM_HOME/unknown.jsonl`:
 * Volley never runs them.
 */

export const TAILSCALE_VERSION = "1.76.1";
export const SIM_DNS_NAME = "sim-machine.example.ts.net.";
export const SIM_ADDRESS = "100.64.0.2";
export const SIM_LOGIN_URL = "https://login.tailscale.com/a/simulated";

/** Marks the first `tailscale up` (its link printed): `$VOLLEY_SIM_HOME/tailscale-up`. */
export const UP_MARKER = "tailscale-up";

/** The serve config, `{ "<https port>": "<proxy>" }`: `$VOLLEY_SIM_HOME/tailscale-serve.json`. */
export const SERVE_FILE = "tailscale-serve.json";

function readServes(home: string): Record<string, string> {
  try {
    return JSON.parse(readFileSync(join(home, SERVE_FILE), "utf-8")) as Record<string, string>;
  } catch {
    return {};
  }
}

function writeServes(home: string, serves: Record<string, string>): void {
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, SERVE_FILE), `${JSON.stringify(serves)}\n`);
}

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
  const name = SIM_DNS_NAME.replace(/\.$/, "");
  if (line === "serve status --json") {
    const serves = Object.entries(readServes(home));
    if (serves.length === 0) return ok("{}\n");
    return ok(
      `${JSON.stringify(
        {
          TCP: Object.fromEntries(serves.map(([p]) => [p, { HTTPS: true }])),
          Web: Object.fromEntries(
            serves.map(([p, proxy]) => [`${name}:${p}`, { Handlers: { "/": { Proxy: proxy } } }]),
          ),
        },
        null,
        2,
      )}\n`,
    );
  }
  const on = /^serve --bg --https=(\d{1,5}) (http:\/\/127\.0\.0\.1:\d{1,5})$/.exec(line);
  if (on !== null) {
    writeServes(home, { ...readServes(home), [on[1] as string]: on[2] as string });
    return ok(`Available within your tailnet:\n\nhttps://${name}:${on[1]}/\n|-- proxy ${on[2]}\n`);
  }
  const off = /^serve --https=(\d{1,5}) off$/.exec(line);
  if (off !== null) {
    const { [off[1] as string]: _gone, ...rest } = readServes(home);
    writeServes(home, rest);
    return ok();
  }
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
