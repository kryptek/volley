import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BUG_DEFAULTS,
  NEVER_READ,
  gatherReport,
  installMethodOf,
  newestWave,
  tailLines,
} from "../../src/bug/gather";
import { identityOf, redactReport } from "../../src/bug/redact";
import { renderReport } from "../../src/bug/report";
import { looksSecret } from "../../src/peer/doctor";
import { bugMachine, ok } from "../helpers/bug-machine";
import { tempDir } from "../helpers/tmp";

const OPTS = { events: BUG_DEFAULTS.events, lines: BUG_DEFAULTS.lines };

describe("installMethodOf", () => {
  const home = "/path/to/home";
  it("the installer's clone, Homebrew's libexec, anything else a clone", () => {
    expect(installMethodOf(`${home}/.volley/src/packages/volley-cli/src`, home)).toBe("installer");
    expect(
      installMethodOf("/opt/homebrew/Cellar/volley/0.13.2/libexec/packages/volley-cli/src", home),
    ).toBe("homebrew");
    expect(installMethodOf("/opt/volley/libexec/packages/volley-cli/src", home)).toBe("homebrew");
    expect(installMethodOf("/path/to/volley/packages/volley-cli/src", home)).toBe("clone");
  });

  it("the header names a clone's describe, -dirty included", async () => {
    const m = bugMachine(tempDir("volley-bug-g-"));
    m.execs.set(
      "git -C /path/to/volley describe --tags --always --dirty",
      ok("v0.13.2-3-gabc1234-dirty\n"),
    );
    const g = await gatherReport(m.deps, OPTS);
    expect(g.header).toContain("volley 0.13.2 · clone (v0.13.2-3-gabc1234-dirty)");
  });
});

describe("newestWave and tailLines", () => {
  it("picks the wave whose journal.jsonl is newest, never _system", () => {
    const m = bugMachine(tempDir("volley-bug-g-"));
    const waves = join(m.vhome, "waves");
    m.write(join(waves, "old", "journal.jsonl"), "{}\n", 1_000);
    m.write(join(waves, "new", "journal.jsonl"), "{}\n", 2_000);
    m.write(join(waves, "_system", "journal.jsonl"), "{}\n", 3_000);
    m.write(join(waves, "empty", "notes.txt"), "x", 4_000);
    expect(newestWave(m.deps, waves)).toBe("new");
    expect(newestWave(m.deps, join(m.vhome, "nowhere"))).toBeNull();
  });

  it("the last n lines; a torn last line is kept as it is", () => {
    expect(tailLines("a\nb\nc\n", 2)).toEqual(["b", "c"]);
    expect(tailLines('a\nb\n{"torn', 2)).toEqual(["b", '{"torn']);
    expect(tailLines("", 3)).toEqual([]);
  });
});

describe("gatherReport", () => {
  it("a probe that times out or is missing is one line; the others are still gathered", async () => {
    const m = bugMachine(tempDir("volley-bug-g-"));
    m.execs.set("volley setup --check --json", "timeout");
    m.execs.set("bun --version", ok("1.3.2\n"));
    const g = await gatherReport(m.deps, OPTS);
    const body = (id: string) => g.sections.find((s) => s.id === id)?.body ?? "";
    expect(body("setup-check")).toBe(
      `(not available: timed out after ${BUG_DEFAULTS.exec_timeout_ms / 1000} s)`,
    );
    expect(body("tools")).toContain("tmux: (not available: exit 127)");
    expect(body("tools")).toContain("bun: 1.3.2");
    expect(g.header).toContain("bun 1.3.2");
  });

  it("gh's sign-in is the active account's; a gh without --active falls back to plain status", async () => {
    const m = bugMachine(tempDir("volley-bug-g-"));
    m.execs.set("gh auth status --active", ok("✓ Logged in to github.com account canary-gh\n"));
    m.execs.set("gh auth status", { code: 1, stdout: "", stderr: "X a stale second account\n" });
    expect((await gatherReport(m.deps, OPTS)).ghSignedIn).toBe(true);

    const old = bugMachine(tempDir("volley-bug-g-"));
    old.execs.set("gh auth status --active", {
      code: 1,
      stdout: "",
      stderr: "unknown flag: --active\n",
    });
    old.execs.set("gh auth status", ok("✓ Logged in to github.com account canary-gh\n"));
    const g = await gatherReport(old.deps, OPTS);
    expect(g.ghSignedIn).toBe(true);
    expect(g.identity.ghLogin).toBe("canary-gh");
  });

  it("volleyd status exiting 69 keeps the diagnosis as the section", async () => {
    const m = bugMachine(tempDir("volley-bug-g-"));
    m.execs.set("volleyd status --json", {
      code: 69,
      stdout: "",
      stderr: "volleyd does not answer: the broker is down.\nFix: volley setup\n",
    });
    const g = await gatherReport(m.deps, OPTS);
    expect(g.sections.find((s) => s.id === "status")?.body).toBe(
      "volleyd does not answer: the broker is down.\nFix: volley setup",
    );
  });

  it("a probe's output longer than section_max is cut, and says so", async () => {
    const m = bugMachine(tempDir("volley-bug-g-"));
    m.execs.set("volleyd status --json", ok(`${"x".repeat(BUG_DEFAULTS.section_max * 2)}\n`));
    const g = await gatherReport(m.deps, OPTS);
    const body = g.sections.find((s) => s.id === "status")?.body ?? "";
    expect(body.length).toBeLessThanOrEqual(BUG_DEFAULTS.section_max + 80);
    expect(body).toMatch(/… cut at 12000 characters \(of \d+\)$/);
  });

  it("the wave's last events, _system's last 10, its newest wave file, the logs bounded", async () => {
    const m = bugMachine(tempDir("volley-bug-g-"));
    const w = join(m.vhome, "waves", "wave-a");
    m.write(
      join(w, "journal.jsonl"),
      `${Array.from({ length: 60 }, (_, i) => JSON.stringify({ seq: i })).join("\n")}\n`,
    );
    m.write(join(w, "v1.yaml"), "wave: wave-a\n# one\n");
    m.write(join(w, "v10.yaml"), "wave: wave-a\n# ten\n");
    m.write(join(w, "v2.yaml"), "wave: wave-a\n# two\n");
    m.write(
      join(m.vhome, "waves", "_system", "journal.jsonl"),
      `${Array.from({ length: 30 }, (_, i) => JSON.stringify({ sys: i })).join("\n")}\n`,
    );
    m.write(
      join(m.vhome, "volleyd.log"),
      `${Array.from({ length: 200 }, (_, i) => `log ${i}`).join("\n")}\n`,
    );
    const g = await gatherReport(m.deps, { events: 5, lines: 3 });
    const body = (id: string) => g.sections.find((s) => s.id === id)?.body ?? "";
    expect(g.wave).toBe("wave-a");
    expect(body("journal").split("\n")).toEqual(
      [55, 56, 57, 58, 59].map((i) => JSON.stringify({ seq: i })),
    );
    expect(body("journal-system").split("\n")).toHaveLength(10);
    expect(body("wave-file")).toContain("# ten");
    expect(body("log-volleyd").split("\n")).toEqual(["log 197", "log 198", "log 199"]);
    expect(body("log-desk")).toBe("(not available: no such file)");
  });

  it("setup.json: layout, network kind, terminal and Desk port only", async () => {
    const m = bugMachine(tempDir("volley-bug-g-"));
    m.write(
      join(m.vhome, "setup.json"),
      JSON.stringify({
        layout: "brew-arm64",
        config: "/x/mosquitto.conf",
        state_file: "/x/dynamic-security.json",
        auth_dir: "/x/auth",
        desk_port: 5199,
        terminal: "tmux",
        network: { kind: "tailscale", name: "studio.tail1.ts.net", address: "100.64.0.2" },
      }),
    );
    const g = await gatherReport(m.deps, OPTS);
    expect(g.sections.find((s) => s.id === "setup")?.body).toBe(
      "layout: brew-arm64\nnetwork: tailscale\nlocal_terminal: tmux\ndesk_port: 5199",
    );
    expect(g.header).toContain("layout brew-arm64 · network tailscale · this machine: supervisor");
  });
});

describe("the canary: a seeded home, gathered and redacted, leaks nothing", () => {
  const CANARIES = [
    "vly_admin_0badf00d_CANARYSECRET",
    "CANARYSECRET",
    "CANARY-PASSWORD",
    "canary@example.com",
    "canary-host",
    "canaryuser",
    "canaryorg/canaryrepo",
    "canaryorg",
    "canary-gh",
    "canary-box-7",
    "canarys-macbook-pro",
  ];

  it("none of the canaries appears, and the never-read files are never opened", async () => {
    const home = tempDir("volley-bug-canary-");
    const m = bugMachine(home);
    const v = m.vhome;
    const w = join(v, "waves", "wave-2026-10-25");
    // Credential files: never to be opened.
    m.write(join(home, "repo", ".volley", "agent.json"), '{"password":"CANARY-PASSWORD"}');
    m.write(join(v, "auth", "coordinator.json"), '{"password":"CANARY-PASSWORD"}');
    m.write(join(v, "dynamic-security.json"), '{"password":"CANARY-PASSWORD"}');
    m.write(join(w, "screens", "u8.txt"), "CANARY-PASSWORD on screen");
    // Files the report reads, each carrying a canary.
    m.write(
      join(v, "setup.json"),
      JSON.stringify({
        layout: "linux-apt",
        config: "/etc/mosquitto/mosquitto.conf",
        state_file: "/var/lib/mosquitto/dynamic-security.json",
        auth_dir: join(v, "auth"),
        network: { kind: "tailscale", name: "canary-host.tail9.ts.net", address: "100.64.9.9" },
      }),
    );
    m.write(
      join(home, ".volley", "peer.json"),
      JSON.stringify({ name: "canary-host", remote_port: 21883, password: "CANARY-PASSWORD" }),
    );
    m.write(join(v, "config.yaml"), "repos:\n  - repo: canaryorg/canaryrepo\n");
    m.write(
      join(w, "journal.jsonl"),
      [
        { event: "token_minted", detail: "vly_admin_0badf00d_CANARYSECRET" },
        { event: "spawn", cwd: join(home, "repos", "canaryrepo"), repo: "canaryorg/canaryrepo" },
        { event: "note", by: "canary@example.com", host: "canary-host", ip: "100.64.9.9" },
        { event: "url", url: "mqtt://coordinator:CANARY-PASSWORD@canary-host:1883" },
      ]
        .map((e) => JSON.stringify(e))
        .join("\n")
        .concat("\n"),
    );
    m.write(join(w, "v1.yaml"), "wave: wave-2026-10-25\nrepo: canaryorg/canaryrepo\n");
    m.write(
      join(v, "volleyd.log"),
      `canaryuser started on canary-host.example.lan; login ?code=CANARYSECRET&state=x\npassword: CANARY-PASSWORD\nBearer CANARYSECRET\n${join(home, "x")}\n`,
    );
    m.write(join(home, ".volley", "peer.log"), "peer canary-gh pushed to canaryorg/canaryrepo\n");
    m.execs.set(
      "gh auth status --active",
      ok("✓ Logged in to github.com account canary-gh (keyring)\n"),
    );
    m.execs.set("git config --get user.name", ok("Canary Person\n"));
    m.execs.set(
      "volley peer doctor --json",
      ok(
        JSON.stringify({
          checks: [{ id: "gh", ok: true, detail: "canary-gh, canaryorg/canaryrepo" }],
          repos: [{ machines: [{ host: "canary-box-7", detail: "not on canary-box-7 yet" }] }],
        }),
      ),
    );
    m.execs.set(
      "volleyd status --json",
      ok(JSON.stringify({ machines: [{ machine: "canarys-macbook-pro", state: "up" }] })),
    );

    const g = await gatherReport(m.deps, OPTS);
    const text = redactReport(
      renderReport(g, { message: "it broke for canaryuser", keepRepos: false }),
      identityOf({ ...m.deps, volleydHome: v, ...g.identity }),
      { keepRepos: false },
    );
    for (const c of CANARIES) expect(text, c).not.toContain(c);
    for (const line of text.split("\n")) expect(looksSecret(line), line).toBe(false);
    expect(text).toContain("vly_admin_0badf00d_[redacted]");
    expect(text).toContain("wave-2026-10-25");
    for (const path of m.reads) {
      for (const re of NEVER_READ) expect(re.test(path), path).toBe(false);
    }
    expect(m.reads.some((p) => p.includes("screens"))).toBe(false);
    expect(m.reads.some((p) => p.endsWith("agent.json"))).toBe(false);
    expect(m.reads.some((p) => p.includes(join(v, "auth")))).toBe(false);
    expect(text).toContain("screens");
  });
});
