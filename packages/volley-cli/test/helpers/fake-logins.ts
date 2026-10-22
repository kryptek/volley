import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { UsageFetch } from "../../src/peer/usage-probe";

/**
 * Claude Code logins on a fake machine for the usage probe: a credentials file per profile (what
 * Claude Code writes on Linux) and a scripted usage endpoint. The token is not SECRET_RE-shaped,
 * so a test that finds it nowhere proves the probe's redaction, not the doctor's scrub.
 */

export const FAKE_TOKEN = "FAKE-TOKEN-7f3a9c";

/** The usage endpoint's answer, as public reports show it. */
export const USAGE_JSON = {
  five_hour: { utilization: 37.0, resets_at: "2026-10-19T12:00:00.000000+00:00" },
  seven_day: { utilization: 56.0, resets_at: "2026-10-24T00:00:00.000000+00:00" },
  seven_day_opus: null,
  limits: [
    {
      kind: "weekly_scoped",
      percent: 12,
      resets_at: "2026-10-24T00:00:00Z",
      scope: { model: { id: null, display_name: "Fable" } },
    },
  ],
};

/** `default` (`~/.claude`) and each profile under `~/.volley/claude`: expiresAt per login. */
export function storeLogins(home: string, logins: Record<string, number>): void {
  for (const [profile, expiresAt] of Object.entries(logins)) {
    const dir =
      profile === "default" ? join(home, ".claude") : join(home, ".volley", "claude", profile);
    mkdirSync(dir, { recursive: true });
    if (profile !== "default") writeFileSync(join(dir, ".claude.json"), "{}");
    writeFileSync(
      join(dir, ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { accessToken: FAKE_TOKEN, expiresAt } }),
    );
  }
}

/** A usage endpoint answering `json` (or throwing `fail`'s error); every request it saw. */
export function usageEndpoint(
  o: { json?: unknown; fail?: (headers: Record<string, string>) => Error } = {},
) {
  const requests: Record<string, string>[] = [];
  const fetch: UsageFetch = async (_url, init) => {
    requests.push(init.headers);
    if (o.fail !== undefined) throw o.fail(init.headers);
    return { status: 200, json: async () => o.json ?? USAGE_JSON };
  };
  return { fetch, requests };
}
