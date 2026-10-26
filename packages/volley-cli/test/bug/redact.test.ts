import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type Identity, identityOf, redactReport } from "../../src/bug/redact";
import { looksSecret } from "../../src/peer/doctor";
import { tempDir } from "../helpers/tmp";

// Home paths are built at runtime: scripts/no-home-paths.test.ts refuses the literal.
const HOME = ["", "Users", "canaryuser"].join("/");
const FOREIGN = ["", "home", "someone"].join("/");

const ID: Identity = {
  users: ["canaryuser"],
  home: HOME,
  hosts: ["canary-host.example.lan", "canary-host"],
  ghLogin: "canary-gh",
  gitNames: ["Canary Person"],
  repos: ["canaryorg/canaryrepo", "otherorg/tool"],
};
const r = (s: string, keepRepos = false) => redactReport(s, ID, { keepRepos });

describe("redactReport — rule 1, tokens and secrets", () => {
  it.each([
    ["vly_admin_0badf00d_s3cr3t", "vly_admin_0badf00d_[redacted]"],
    [`key sk-ant-api03-${"A".repeat(30)}`, "key [redacted]"],
    [`ghp_${"a".repeat(36)}`, "[redacted]"],
    ["github_pat_11ABCDEF_xyz", "[redacted]"],
    [`commit ${"0123456789abcdef".repeat(2)}01234567`, "commit [redacted]"],
    ["jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJlLXNpZw", "jwt [jwt]"],
    [
      "https://desk.example/cb?code=abc&state=xyz",
      "https://desk.example/cb?code=[redacted]&state=[redacted]",
    ],
    ["Authorization: Bearer abc.def", "Authorization: Bearer [redacted]"],
    ["mqtt://bob:pw@broker:1883", "mqtt://[user]:[redacted]@broker:1883"],
    ["wss://bob:pw@desk.example:9001/mqtt", "wss://[user]:[redacted]@desk.example:9001/mqtt"],
    ["password: hunter2", 'password: "[redacted]"'],
    ['{"token": "abc-123", "n": 1}', '{"token": "[redacted]", "n": 1}'],
    ['"VOLLEY_AUTH_PASSWORD": "x"', '"VOLLEY_AUTH_PASSWORD": "[redacted]"'],
    ["VOLLEY_AUTH_PASSWORD=x volley pub", "VOLLEY_AUTH_PASSWORD=[redacted] volley pub"],
    ["volley pub --password hunter2 x", "volley pub --password [redacted] x"],
  ])("%s", (input, expected) => {
    expect(r(input)).toBe(expected);
  });
});

describe("redactReport — rule 2, identity", () => {
  it("e-mails", () => {
    expect(r("author canary@example.com and 1+x@users.noreply.github.com")).toBe(
      "author [email] and [email]",
    );
  });
  it("the username as a whole word only", () => {
    expect(r("canaryuser ran it; canaryusers is another word")).toBe(
      "[user] ran it; canaryusers is another word",
    );
  });
  it("HOME and a foreign home prefix become ~", () => {
    expect(r(`${HOME}/.volley/volleyd/volleyd.log`)).toBe("~/.volley/volleyd/volleyd.log");
    expect(r(`cd ${FOREIGN}/repos/x`)).toBe("cd ~/repos/x");
    expect(r(`${["", "Users", "canaryuser", "x"].join("/")}`)).toBe("~/x");
  });
  it("hostnames, long and short, and any tailnet name", () => {
    expect(r("on canary-host.example.lan and canary-host and box.tail1234.ts.net")).toBe(
      "on [host] and [host] and [host]",
    );
  });
  it("a hostname or user inside a hyphenated name (a profile, a coordinator name)", () => {
    expect(r("profile claude-login-canary-host; coord-canaryuser; canary-hostess")).toBe(
      "profile claude-login-[host]; coord-[user]; canary-hostess",
    );
  });
  it("a known name cut short by a 200-character detail (`canary-ho…`)", () => {
    expect(r("--machine canary-host.exa…")).toBe("--machine [host]…");
    expect(r("--machine canary-ho…")).toBe("--machine [host]…");
    expect(r("a sentence ends…")).toBe("a sentence ends…");
  });
  it("a computer named after its owner, known or not", () => {
    expect(r("on sams-macbook-pro and Dana's MacBook Air and alex-imac.local")).toBe(
      "on [host] and [host] and [host].local",
    );
  });
  it("IP literals, except loopback and unspecified", () => {
    expect(r("203.0.113.7 2001:db8::1 100.64.0.2 fd7a:115c:a1e0::2")).toBe("[ip] [ip] [ip] [ip]");
    const keep = "127.0.0.1 localhost:1883 0.0.0.0 ::1 :: at 12:30:45 v0.13.2";
    expect(r(keep)).toBe(keep);
  });
  it("the gh login and the git identity", () => {
    expect(r("gh as canary-gh; commits as Canary Person")).toBe(
      "gh as [gh-user]; commits as [user]",
    );
  });
});

describe("redactReport — rule 3, repositories", () => {
  it("slugs become [repo-N] in first-seen order, stable across the text", () => {
    expect(r("otherorg/tool then canaryorg/canaryrepo, again otherorg/tool")).toBe(
      "[repo-1] then [repo-2], again [repo-1]",
    );
  });
  it("a repository's bare name as a path segment (its clone)", () => {
    expect(r("canaryorg/canaryrepo cloned at ~/repos/canaryrepo; canaryrepo-notes stays")).toBe(
      "[repo-1] cloned at ~/repos/[repo-1]; canaryrepo-notes stays",
    );
  });
  it("--keep-repos leaves them", () => {
    const t = "canaryorg/canaryrepo and otherorg/tool";
    expect(r(t, true)).toBe(t);
  });
  it("wave names and task ids are untouched", () => {
    const t = "wave wave-2026-10-25 task U8 closes #123";
    expect(r(t)).toBe(t);
  });
});

describe("redactReport — properties", () => {
  const fixture = Array.from(
    { length: 200 },
    (_, i) =>
      [
        `line ${i} ${HOME}/x canaryuser@canary-host 203.0.113.${i % 250}`,
        `vly_admin_0badf00d_SECRET${i} mqtt://u:p${i}@canary-host:1883 canaryorg/canaryrepo`,
        `"password": "p${i}" eyJa.eyJb.c${i} ghp_${"b".repeat(36)} 127.0.0.1:1883 wave-2026-10-25`,
      ][i % 3],
  ).join("\n");

  it("is idempotent", () => {
    const once = r(fixture);
    expect(r(once)).toBe(once);
  });
  it("leaves no token-shaped line", () => {
    for (const line of r(fixture).split("\n")) expect(looksSecret(line)).toBe(false);
  });
});

describe("identityOf", () => {
  it("reads $SUDO_USER before $USER, the hostnames, setup.json's network and peer.json's name", () => {
    const home = tempDir("volley-bug-id-");
    const vhome = join(home, ".volley", "volleyd");
    mkdirSync(vhome, { recursive: true });
    writeFileSync(
      join(vhome, "setup.json"),
      JSON.stringify({
        network: { kind: "tailscale", name: "studio.tail1.ts.net", address: "100.64.0.2" },
      }),
    );
    writeFileSync(
      join(home, ".volley", "peer.json"),
      JSON.stringify({ name: "box-a", remote_port: 21883, repos: ["acme/app"] }),
    );
    const id = identityOf({
      env: { USER: "plain", SUDO_USER: "invoker", HOME: home },
      home,
      volleydHome: vhome,
      hostname: () => "Studio.local",
      username: () => "plain",
      readFile: (p) => {
        try {
          return readFileSync(p, "utf-8");
        } catch {
          return null;
        }
      },
      ghLogin: "octo",
      gitNames: ["Octo Person"],
      repos: ["acme/web"],
    });
    expect(id.users[0]).toBe("invoker");
    expect(id.users).toContain("plain");
    expect(id.hosts).toEqual(
      expect.arrayContaining([
        "Studio.local",
        "Studio",
        "studio.tail1.ts.net",
        "100.64.0.2",
        "box-a",
      ]),
    );
    expect(id.repos).toEqual(expect.arrayContaining(["acme/app", "acme/web"]));
    expect(id.ghLogin).toBe("octo");
  });

  it("tolerates a missing setup.json and peer.json", () => {
    const id = identityOf({
      env: { USER: "plain" },
      home: "/path/to/home",
      volleydHome: "/path/to/home/.volley/volleyd",
      hostname: () => "box",
      username: () => "plain",
      readFile: () => null,
    });
    expect(id.users).toEqual(["plain"]);
    expect(id.hosts).toEqual(["box"]);
    expect(id.repos).toEqual([]);
  });
});
