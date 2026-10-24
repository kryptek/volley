import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ExecResult, PeerExec } from "../../src/commands/peer";
import {
  type Login,
  PROBE_DEFAULTS,
  PROBE_FAMILIES,
  type ProbeDeps,
  USAGE_URL,
  type UsageFetch,
  credentialArgv,
  findLogins,
  keychainService,
  memoPath,
  parseUsageResponse,
  probeLogin,
  probeLogins,
  readCredential,
  withRedacted,
} from "../../src/peer/usage-probe";
import { tempDir } from "../helpers/tmp";

/**
 * The per-machine Claude usage probe: read-only, never leaked, numbers only out, gentle. Every
 * fake token is `FAKE-TOKEN-7f3a9c`, which the doctor's SECRET_RE does not match, so the
 * redaction wrapper (not the pattern) is what the leak test proves.
 */

const TOKEN = "FAKE-TOKEN-7f3a9c";
const NOW = new Date("2026-10-21T09:00:00.000Z");
const at = (min: number) => new Date(NOW.getTime() + min * 60_000);
/** sha256("/path/to/home/.volley/claude/work") (NFC), first 8 hex characters. */
const WORK_HASH = "f8568817";

/** What the usage endpoint answered in public reports (2026-10). */
const FIXTURE = {
  five_hour: { utilization: 33.0, resets_at: "2026-04-11T07:00:00.528743+00:00" },
  seven_day: { utilization: 13.0, resets_at: "2026-04-17T00:59:59.951713+00:00" },
  seven_day_opus: null,
  seven_day_sonnet: { utilization: 1.0, resets_at: "2026-04-16T03:00:00.951719+00:00" },
  limits: [
    {
      kind: "weekly_scoped",
      group: "weekly",
      percent: 100,
      severity: "critical",
      is_active: true,
      resets_at: "2026-09-19T09:00:00Z",
      scope: { model: { id: null, display_name: "Fable" } },
    },
    { kind: "session", percent: 9 },
    { kind: "weekly_all", percent: 68 },
  ],
  extra_usage: { is_enabled: false, monthly_limit: null, used_credits: null, utilization: null },
};

const credentialJson = (o: { token?: unknown; expiresAt?: unknown } = {}) =>
  JSON.stringify({
    claudeAiOauth: {
      ...("token" in o ? { accessToken: o.token } : { accessToken: TOKEN }),
      refreshToken: "FAKE-REFRESH-0000",
      ...("expiresAt" in o ? { expiresAt: o.expiresAt } : { expiresAt: at(60).getTime() }),
      scopes: ["user:inference"],
    },
  });

interface Fake {
  deps: ProbeDeps;
  argv: string[][];
  requests: { url: string; headers: Record<string, string>; timeoutMs: number }[];
  home: string;
}

/** A machine: a temp HOME, an exec that answers `security`, and a scripted fetch. */
function fake(
  o: {
    platform?: NodeJS.Platform;
    keychain?: string | null;
    answer?: (n: number) => ReturnType<UsageFetch>;
  } = {},
): Fake {
  const home = tempDir("volley-usage-probe-");
  const argv: string[][] = [];
  const requests: Fake["requests"] = [];
  const exec: PeerExec = async (a) => {
    argv.push(a);
    const r: ExecResult = { code: 0, stdout: "", stderr: "" };
    if (a[0] === "security") {
      if (o.keychain === null || o.keychain === undefined) {
        return { ...r, code: 44, stderr: "security: The specified item could not be found.\n" };
      }
      return { ...r, stdout: `${o.keychain}\n` };
    }
    return r;
  };
  const fetch: UsageFetch = async (url, init) => {
    requests.push({ url, headers: init.headers, timeoutMs: init.timeoutMs });
    return (o.answer ?? (async () => ({ status: 200, json: async () => FIXTURE })))(
      requests.length,
    );
  };
  return {
    home,
    argv,
    requests,
    deps: {
      exec,
      fetch,
      platform: o.platform ?? "linux",
      home,
      env: { USER: "u" },
      claudeVersion: "2.1.3",
    },
  };
}

const defaultLogin = (home: string): Login => ({
  profile: "default",
  dir: join(home, ".claude"),
  isDefault: true,
});

/** Write a credentials file for a login. */
function storeFile(login: Login, text = credentialJson()) {
  mkdirSync(login.dir, { recursive: true });
  writeFileSync(join(login.dir, ".credentials.json"), text);
}

describe("parseUsageResponse", () => {
  it("reads the fixture: 5-hour, weekly, a legacy family key and a limits[] family", () => {
    expect(parseUsageResponse(FIXTURE)).toEqual({
      five_hour: { pct: 33, resets_at: "2026-04-11T07:00:00.528Z" },
      weekly: { pct: 13, resets_at: "2026-04-17T00:59:59.951Z" },
      model_weekly: {
        // 1.0 is 1 %, never rescaled to 100.
        sonnet: { pct: 1, resets_at: "2026-04-16T03:00:00.951Z" },
        fable: { pct: 100, resets_at: "2026-09-19T09:00:00.000Z" },
      },
    });
  });

  it("a legacy seven_day_opus object without limits[] is opus; null is no window", () => {
    const r = parseUsageResponse({
      five_hour: { utilization: 5, resets_at: null },
      seven_day_opus: { utilization: 40, resets_at: "2026-10-25T00:00:00Z" },
    });
    expect(r).toMatchObject({ model_weekly: { opus: { pct: 40 } } });
    const none = parseUsageResponse({ five_hour: { utilization: 5 }, seven_day_opus: null });
    expect(none).not.toHaveProperty("model_weekly");
  });

  it("limits[] wins over the legacy key for the same family; a model id names it too", () => {
    const r = parseUsageResponse({
      five_hour: { utilization: 5 },
      seven_day_opus: { utilization: 40, resets_at: null },
      limits: [{ kind: "weekly_scoped", percent: 70, scope: { model: { id: "claude-opus-5-5" } } }],
    });
    expect(r).toMatchObject({ model_weekly: { opus: { pct: 70, resets_at: null } } });
  });

  it("percents are kept as they are and clamped; bad dates are null; unknown keys ignored", () => {
    expect(
      parseUsageResponse({
        five_hour: { utilization: 0.5, resets_at: "not a date" },
        seven_day: { utilization: 140 },
        spend_limit: { anything: true },
        brand_new_key: 1,
      }),
    ).toEqual({
      five_hour: { pct: 0.5, resets_at: null },
      weekly: { pct: 100, resets_at: null },
    });
  });

  it("no five_hour object at all is an unexpected shape", () => {
    expect(parseUsageResponse({ seven_day: { utilization: 1 } })).toEqual({ state: "error" });
    expect(parseUsageResponse(null)).toEqual({ state: "error" });
    expect(parseUsageResponse([])).toEqual({ state: "error" });
  });

  it("PROBE_FAMILIES are exactly volleyd's model families", () => {
    const src = readFileSync(
      join(__dirname, "..", "..", "..", "volleyd", "src", "claude", "context-window.ts"),
      "utf-8",
    );
    const families = /const FAMILY = \/claude-\(([a-z|]+)\)/.exec(src)?.[1]?.split("|");
    expect([...PROBE_FAMILIES].sort()).toEqual([...(families ?? [])].sort());
  });
});

describe("logins and credential sources", () => {
  it("finds the default profile and every profile dir with a .claude.json", () => {
    const home = tempDir("volley-usage-logins-");
    const root = join(home, ".volley", "claude");
    for (const id of ["work", "spare", "Bad Name"]) mkdirSync(join(root, id), { recursive: true });
    writeFileSync(join(root, "work", ".claude.json"), "{}");
    writeFileSync(join(root, "Bad Name", ".claude.json"), "{}");
    writeFileSync(join(root, "accounts.json"), "{}");
    expect(findLogins(home, {})).toEqual([
      { profile: "default", dir: join(home, ".claude"), isDefault: true },
      { profile: "work", dir: join(root, "work"), isDefault: false },
    ]);
    // $VOLLEY_CLAUDE_DIR is the root when set (no trailing slash in the dir).
    const other = join(home, "elsewhere");
    mkdirSync(join(other, "team"), { recursive: true });
    writeFileSync(join(other, "team", ".claude.json"), "{}");
    expect(findLogins(home, { VOLLEY_CLAUDE_DIR: `${other}/` }).map((l) => l.dir)).toEqual([
      join(home, ".claude"),
      join(other, "team"),
    ]);
  });

  it("at most 16 logins", () => {
    const home = tempDir("volley-usage-logins-");
    for (let i = 0; i < 20; i++) {
      const dir = join(home, ".volley", "claude", `p${String(i).padStart(2, "0")}`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, ".claude.json"), "{}");
    }
    expect(findLogins(home, {})).toHaveLength(16);
  });

  it("macOS: the Keychain item Claude Code keeps per config dir", () => {
    expect(keychainService(null)).toBe("Claude Code-credentials");
    expect(keychainService("/path/to/home/.volley/claude/work")).toBe(
      `Claude Code-credentials-${WORK_HASH}`,
    );
    expect(credentialArgv(keychainService("/path/to/home/.volley/claude/work"), "u")).toEqual([
      "security",
      "find-generic-password",
      "-s",
      `Claude Code-credentials-${WORK_HASH}`,
      "-a",
      "u",
      "-w",
    ]);
  });

  it("macOS reads the Keychain item: the profile's hashed service, the default's unsuffixed", async () => {
    const f = fake({ platform: "darwin", keychain: credentialJson() });
    const work: Login = {
      profile: "work",
      dir: "/path/to/home/.volley/claude/work",
      isDefault: false,
    };
    expect(await readCredential(f.deps, work, NOW)).toEqual({
      token: TOKEN,
      expiresAt: at(60).getTime(),
    });
    await readCredential(f.deps, defaultLogin(f.home), NOW);
    expect(f.argv).toEqual([
      credentialArgv(`Claude Code-credentials-${WORK_HASH}`, "u"),
      credentialArgv("Claude Code-credentials", "u"),
    ]);
    // No $USER: Claude Code's own fallback account.
    const g = fake({ platform: "darwin", keychain: credentialJson() });
    await readCredential({ ...g.deps, env: {} }, work, NOW);
    expect(g.argv[0]?.[5]).toBe("claude-code-user");
  });

  it("a Keychain miss reads <dir>/.credentials.json", async () => {
    const f = fake({ platform: "darwin", keychain: null });
    const login = defaultLogin(f.home);
    storeFile(login);
    expect(await readCredential(f.deps, login, NOW)).toMatchObject({ token: TOKEN });
    expect(f.argv.map((a) => a[1])).toEqual(["find-generic-password"]);
  });

  it("linux reads the file only and never runs security", async () => {
    const f = fake({ platform: "linux", keychain: credentialJson() });
    const login = defaultLogin(f.home);
    storeFile(login);
    expect(await readCredential(f.deps, login, NOW)).toMatchObject({ token: TOKEN });
    expect(f.argv).toEqual([]);
  });

  it("no accessToken or malformed JSON is no_credential; a past expiresAt is expired, with no fetch", async () => {
    const f = fake();
    const login = defaultLogin(f.home);
    expect(await readCredential(f.deps, login, NOW)).toEqual({ state: "no_credential" });
    storeFile(login, credentialJson({ token: undefined }));
    expect(await readCredential(f.deps, login, NOW)).toEqual({ state: "no_credential" });
    storeFile(login, `{"claudeAiOauth": {"accessToken": "${TOKEN}"`);
    expect(await readCredential(f.deps, login, NOW)).toEqual({ state: "no_credential" });
    storeFile(login, credentialJson({ expiresAt: at(-1).getTime() }));
    expect(await readCredential(f.deps, login, NOW)).toEqual({ state: "expired" });
    storeFile(login, credentialJson({ expiresAt: undefined }));
    expect(await readCredential(f.deps, login, NOW)).toEqual({ state: "expired" });

    storeFile(login, credentialJson({ expiresAt: NOW.getTime() }));
    const r = await probeLogin(f.deps, login, NOW);
    expect(r).toEqual({ profile: "default", state: "expired", attempted_at: NOW.toISOString() });
    expect(f.requests).toEqual([]);
  });

  it("the probe runs nothing but find-generic-password and writes nothing under a profile dir", async () => {
    const f = fake({ platform: "darwin", keychain: credentialJson() });
    const login = defaultLogin(f.home);
    mkdirSync(login.dir, { recursive: true });
    await probeLogin(f.deps, login, NOW);
    expect(f.argv.length).toBeGreaterThan(0);
    for (const a of f.argv) expect(a.slice(0, 2)).toEqual(["security", "find-generic-password"]);
    expect(f.argv.flat()).not.toContain("add-generic-password");
    expect(f.argv.flat().some((w) => /claude$/.test(w))).toBe(false);
  });
});

describe("the request", () => {
  it("GETs the usage endpoint with the four headers and a 10 s timeout; a 200 is ok", async () => {
    const f = fake();
    const login = defaultLogin(f.home);
    storeFile(login);
    const r = await probeLogin(f.deps, login, NOW);
    expect(f.requests).toEqual([
      {
        url: USAGE_URL,
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          "anthropic-beta": "oauth-2025-04-20",
          "User-Agent": "claude-code/2.1.3",
          Accept: "application/json",
        },
        timeoutMs: 10_000,
      },
    ]);
    expect(USAGE_URL).toBe("https://api.anthropic.com/api/oauth/usage");
    // The token is in Authorization only.
    const { Authorization: _auth, ...rest } = f.requests[0]?.headers ?? {};
    expect(JSON.stringify(rest)).not.toContain(TOKEN);
    expect(r).toEqual({
      profile: "default",
      state: "ok",
      attempted_at: NOW.toISOString(),
      reading: { read_at: NOW.toISOString(), ...parseUsageResponse(FIXTURE) },
    });
  });

  it("a 200 with an unexpected shape is error", async () => {
    const f = fake({ answer: async () => ({ status: 200, json: async () => ({ nope: 1 }) }) });
    const login = defaultLogin(f.home);
    storeFile(login);
    expect((await probeLogin(f.deps, login, NOW)).state).toBe("error");
  });
});

describe("never leaked", () => {
  it("withRedacted re-throws an error with the token replaced", async () => {
    await expect(
      withRedacted(TOKEN, async () => {
        throw new Error(`boom Bearer ${TOKEN}`);
      }),
    ).rejects.toThrow(/^boom Bearer \[redacted\]$/);
    await expect(
      withRedacted(TOKEN, async () => {
        throw `string ${TOKEN}`;
      }),
    ).rejects.toThrow("string [redacted]");
    expect(await withRedacted(TOKEN, async () => 7)).toBe(7);
  });

  it("a fetch that throws with the header, a 500 echoing the token, a Keychain echoing the credential: no token anywhere", async () => {
    const answers: ((headers: Record<string, string>) => ReturnType<UsageFetch>)[] = [
      async (h) => {
        throw new Error(`boom ${h.Authorization}`);
      },
      async () => ({ status: 500, json: async () => ({ error: `bad token ${TOKEN}` }) }),
    ];
    for (const answer of answers) {
      const f = fake({ platform: "darwin", keychain: credentialJson() });
      const fetch: UsageFetch = async (url, init) => {
        f.requests.push({ url, headers: init.headers, timeoutMs: init.timeoutMs });
        return answer(init.headers);
      };
      const login = defaultLogin(f.home);
      const r = await probeLogin({ ...f.deps, fetch }, login, NOW);
      expect(r.state).toBe("error");
      expect(JSON.stringify(r)).not.toContain(TOKEN);
      expect(readFileSync(memoPath(f.home, "default"), "utf-8")).not.toContain(TOKEN);
    }
  });
});

describe("memo and cadence", () => {
  const status = (s: number) => async () => ({ status: s, json: async () => FIXTURE });

  it("repeats the memo within the interval, calls again after it", async () => {
    const f = fake();
    const login = defaultLogin(f.home);
    storeFile(login);
    const first = await probeLogin(f.deps, login, NOW);
    expect(await probeLogin(f.deps, login, at(4))).toEqual(first);
    expect(f.requests).toHaveLength(1);
    const later = await probeLogin(f.deps, login, at(6));
    expect(f.requests).toHaveLength(2);
    expect(later.reading?.read_at).toBe(at(6).toISOString());
    expect(PROBE_DEFAULTS.usage_probe_min_interval_s).toBe(300);
  });

  it("429 backs off 10, 20, 40, 60, 60 min; the reading survives; a 200 clears it", async () => {
    let code = 200;
    const f = fake({ answer: async () => status(code)() });
    const login = defaultLogin(f.home);
    // A token that outlives the four hours this test moves through.
    storeFile(login, credentialJson({ expiresAt: at(24 * 60).getTime() }));
    await probeLogin(f.deps, login, NOW);
    const memo = () =>
      JSON.parse(readFileSync(memoPath(f.home, "default"), "utf-8")) as {
        state: string;
        backoff_until?: string;
        attempted_at: string;
        reading?: { read_at: string };
      };
    code = 429;
    let t = 6;
    for (const wait of [10, 20, 40, 60, 60]) {
      const r = await probeLogin(f.deps, login, at(t));
      expect(r.state).toBe("rate_limited");
      expect(r.reading?.read_at).toBe(NOW.toISOString());
      expect(memo().backoff_until).toBe(at(t + wait).toISOString());
      // Before backoff_until: no call (beyond the normal interval too).
      const calls = f.requests.length;
      expect((await probeLogin(f.deps, login, at(t + wait - 1))).state).toBe("rate_limited");
      expect(f.requests).toHaveLength(calls);
      t += wait;
    }
    code = 200;
    expect((await probeLogin(f.deps, login, at(t))).state).toBe("ok");
    expect(memo().backoff_until).toBeUndefined();
    // 5xx is error with a backoff from 10 again.
    code = 503;
    expect((await probeLogin(f.deps, login, at(t + 6))).state).toBe("error");
    expect(memo().backoff_until).toBe(at(t + 16).toISOString());
  });

  it("401 is rejected at the normal interval, no backoff", async () => {
    const f = fake({ answer: status(401) });
    const login = defaultLogin(f.home);
    storeFile(login);
    const r = await probeLogin(f.deps, login, NOW);
    expect(r.state).toBe("rejected");
    const memo = JSON.parse(readFileSync(memoPath(f.home, "default"), "utf-8"));
    expect(memo).not.toHaveProperty("backoff_until");
    await probeLogin(f.deps, login, at(6));
    expect(f.requests).toHaveLength(2);
  });

  it("another status (a redirect, a 404) is error at the normal interval, no backoff", async () => {
    for (const code of [302, 404]) {
      const f = fake({ answer: status(code) });
      const login = defaultLogin(f.home);
      storeFile(login);
      expect((await probeLogin(f.deps, login, NOW)).state).toBe("error");
      const memo = JSON.parse(readFileSync(memoPath(f.home, "default"), "utf-8"));
      expect(memo).not.toHaveProperty("backoff_until");
      await probeLogin(f.deps, login, at(6));
      expect(f.requests).toHaveLength(2);
    }
  });

  it("probes every login at once, so one slow login does not add up across 16", async () => {
    let started = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const f = fake({
      answer: async () => {
        started += 1;
        if (started === 3) release();
        await gate;
        return status(200)();
      },
    });
    storeFile(defaultLogin(f.home));
    for (const id of ["a", "b"]) {
      const dir = join(f.home, ".volley", "claude", id);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, ".claude.json"), "{}");
      storeFile({ profile: id, dir, isDefault: false });
    }
    const logins = await probeLogins(f.deps, NOW);
    expect(logins.map((l) => [l.profile, l.state])).toEqual([
      ["default", "ok"],
      ["a", "ok"],
      ["b", "ok"],
    ]);
  });

  it("only: that one login (a prime's --probe-login); one this machine does not hold: none", async () => {
    const f = fake();
    storeFile(defaultLogin(f.home));
    for (const id of ["a", "b"]) {
      const dir = join(f.home, ".volley", "claude", id);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, ".claude.json"), "{}");
      storeFile({ profile: id, dir, isDefault: false });
    }
    expect((await probeLogins(f.deps, NOW, { only: "b" })).map((l) => l.profile)).toEqual(["b"]);
    expect(await probeLogins(f.deps, NOW, { only: "c" })).toEqual([]);
  });

  it("memo dir 0700, file 0600, numbers only", async () => {
    const f = fake();
    const login = defaultLogin(f.home);
    storeFile(login);
    await probeLogin(f.deps, login, NOW);
    const file = memoPath(f.home, "default");
    expect(file).toBe(join(f.home, ".volley", "claude-usage", "default.json"));
    expect(statSync(join(f.home, ".volley", "claude-usage")).mode & 0o777).toBe(0o700);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const text = readFileSync(file, "utf-8");
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain(login.dir);
    expect(JSON.parse(text)).toMatchObject({
      version: 1,
      profile: "default",
      state: "ok",
      attempted_at: NOW.toISOString(),
    });
  });
});
