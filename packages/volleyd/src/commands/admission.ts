import { parseArgs } from "node:util";
import type { AdmissionSummary } from "../admission";
import { type ControlTarget, resolveControlTarget, withClient } from "../control";
import { type CommandArgs, EXIT, type ExitCode } from "../io";

const HELP = `Usage: volleyd admission [wave] [--json] [--broker-url <url>] [--namespace <ns>]

Show the daemon's current load-aware spawn admission verdict: whether starts are throttled, why
(one reason per signal), each pressure signal with its threshold, and the per-wave verdicts
(with a wave: that wave's only).
--json prints the payload exactly as published on volley/_system/admission (with a wave, its
per-wave verdicts narrowed to that wave).
`;

export async function admission({ argv, env, io }: CommandArgs): Promise<ExitCode> {
  let parsed: ReturnType<typeof parseAdmission>;
  let target: ControlTarget;
  try {
    parsed = parseAdmission(argv);
    target = resolveControlTarget(parsed.values, env);
  } catch (e) {
    io.stderr(`volleyd admission: ${e instanceof Error ? e.message : String(e)}\n${HELP}`);
    return EXIT.USAGE;
  }
  if (parsed.values.help === true) {
    io.stdout(HELP);
    return EXIT.OK;
  }
  if (parsed.positionals.length > 1) {
    io.stderr(`volleyd admission: expected at most one wave\n${HELP}`);
    return EXIT.USAGE;
  }
  const wave = parsed.positionals[0];
  return withClient(target, io, "volleyd admission", async (client) => {
    const res = await client.request("admission", wave !== undefined ? { wave } : {});
    if (!res.ok) {
      io.stderr(`volleyd admission: ${res.error ?? "failed"}\n`);
      return EXIT.ERROR;
    }
    const all = (res.result ?? null) as AdmissionSummary | null;
    const summary = all !== null && wave !== undefined ? admissionFor(all, wave) : all;
    if (parsed.values.json === true) {
      io.stdout(`${JSON.stringify(summary, null, 2)}\n`);
      return EXIT.OK;
    }
    io.stdout(summary === null ? "no pressure sample yet\n" : formatAdmission(summary));
    return EXIT.OK;
  });
}

function parseAdmission(argv: string[]) {
  return parseArgs({
    args: argv,
    options: {
      json: { type: "boolean", default: false },
      "broker-url": { type: "string" },
      namespace: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
    allowPositionals: true,
  });
}

/** The summary with its per-wave verdicts narrowed to `wave` (empty when it has none). */
export function admissionFor(s: AdmissionSummary, wave: string): AdmissionSummary {
  const v = s.waves?.[wave];
  return { ...s, waves: v !== undefined ? { [wave]: v } : {} };
}

/** Human-readable verdict: a header, the reasons, one line per signal, one line per wave. */
export function formatAdmission(s: AdmissionSummary): string {
  const allow = s.allow === null ? "no pressure limit" : `allow ${s.allow}`;
  const lines = [
    `admission: ${s.throttled ? "THROTTLED" : "open"} (${allow})  sampled ${s.sampled_at}`,
  ];
  for (const r of s.reasons) lines.push(`  - ${r}`);
  lines.push("signals:");
  const w = Math.max(...Object.keys(s.signals).map((k) => k.length));
  for (const [name, sig] of Object.entries(s.signals)) {
    const detail =
      sig.value !== undefined
        ? `${sig.value} (max ${sig.max})${sig.clean_samples !== undefined ? `, clean ${sig.clean_samples}` : ""}`
        : (sig.error ?? "not measured");
    lines.push(`  ${name.padEnd(w)}  ${sig.state.padEnd(10)}  ${detail}`);
  }
  const waves = Object.entries(s.waves ?? {});
  if (waves.length > 0) {
    lines.push("waves:");
    for (const [wave, v] of waves) {
      const why = v.reasons.length > 0 ? `  ${v.reasons.join("; ")}` : "";
      lines.push(`  ${wave}  ${v.allow === null ? "open" : `allow ${v.allow}`}${why}`);
    }
  }
  return `${lines.join("\n")}\n`;
}
