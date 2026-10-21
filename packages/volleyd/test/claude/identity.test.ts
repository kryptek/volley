import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loginIdentity, readLoginIdentity } from "../../src/claude/identity";
import { validator } from "../../src/schemas";
import { tempDir } from "../helpers/tmp";

const example = (f: string) =>
  JSON.parse(
    readFileSync(new URL(`../../../../spec/examples/valid/${f}`, import.meta.url), "utf-8"),
  );
const MACHINE = example("machine-peer-doctor.json");
const ACCOUNT = example("claudeaccount-work.json");

/** A profile's `.claude.json` as Claude Code writes it: identity beside much that is not. */
const CLAUDE_JSON = {
  userID: "c0ffee",
  oauthAccount: {
    accountUuid: "11111111-2222-3333-4444-555555555555",
    emailAddress: "owner@example.com",
    organizationUuid: "66666666-7777-8888-9999-000000000000",
    organizationName: "Example Org",
  },
  mcpServers: { volley: { env: { TOKEN: "secret" } } },
  projects: { "/repo": { hasTrustDialogAccepted: true } },
};

describe("loginIdentity: the login's e-mail and org, nothing else", () => {
  it("reads exactly oauthAccount.emailAddress and organizationName", () => {
    const id = loginIdentity(CLAUDE_JSON);
    expect(id).toEqual({ email: "owner@example.com", org: "Example Org" });
    expect(Object.keys(id)).toEqual(["email", "org"]);
  });

  it("is empty for null, a non-object oauthAccount or non-string fields", () => {
    expect(loginIdentity(null)).toEqual({});
    expect(loginIdentity({})).toEqual({});
    expect(loginIdentity({ oauthAccount: "x" })).toEqual({});
    expect(loginIdentity({ oauthAccount: [] })).toEqual({});
    expect(loginIdentity({ oauthAccount: { emailAddress: 42, organizationName: {} } })).toEqual({});
  });

  it("drops a malformed or over-long e-mail and an empty or over-long org", () => {
    for (const emailAddress of ["", "owner", "owner@example", "a b@example.com", "@example.com"])
      expect(loginIdentity({ oauthAccount: { emailAddress } })).toEqual({});
    const long = `${"a".repeat(250)}@example.com`;
    expect(loginIdentity({ oauthAccount: { emailAddress: long } })).toEqual({});
    expect(loginIdentity({ oauthAccount: { organizationName: "" } })).toEqual({});
    expect(loginIdentity({ oauthAccount: { organizationName: "o".repeat(129) } })).toEqual({});
    expect(loginIdentity({ oauthAccount: { organizationName: "o".repeat(128) } })).toEqual({
      org: "o".repeat(128),
    });
  });

  it("drops an address the schemas' format: email rejects", () => {
    for (const emailAddress of ["ü@x.co", "a..b@x.co", "a(b@x.co", "a@-x.co", "a@x_y.co"])
      expect(loginIdentity({ oauthAccount: { emailAddress } })).toEqual({});
  });

  it("every address it keeps validates against machine.schema.json and claude-account.schema.json", () => {
    const machine = validator("machine.schema.json");
    const account = validator("claude-account.schema.json");
    const tries = [
      "owner@example.com",
      "First.Last+tag@sub.example.co.uk",
      "o'neil@x-y.io",
      "ü@x.co",
      "a..b@x.co",
      "a(b@x.co",
      "a@-x.co",
      "a@x_y.co",
      "a@b.c",
    ];
    let kept = 0;
    for (const emailAddress of tries) {
      const { email } = loginIdentity({ oauthAccount: { emailAddress } });
      if (email === undefined) continue;
      kept++;
      const rec = structuredClone(MACHINE);
      rec.payload.auth.claude_email = email;
      const usage = structuredClone(ACCOUNT);
      usage.payload.email = email;
      expect(machine(rec), `${email}: ${JSON.stringify(machine.errors)}`).toBe(true);
      expect(account(usage), `${email}: ${JSON.stringify(account.errors)}`).toBe(true);
    }
    expect(kept).toBeGreaterThanOrEqual(3);
  });

  it("lower-cases the e-mail", () => {
    expect(loginIdentity({ oauthAccount: { emailAddress: "Owner@Example.COM" } })).toEqual({
      email: "owner@example.com",
    });
  });

  it("readLoginIdentity: a missing or unreadable file is {}", () => {
    const dir = tempDir("volleyd-identity-");
    expect(readLoginIdentity(join(dir, "missing.json"))).toEqual({});
    writeFileSync(join(dir, "bad.json"), "{nope");
    expect(readLoginIdentity(join(dir, "bad.json"))).toEqual({});
    writeFileSync(join(dir, ".claude.json"), JSON.stringify(CLAUDE_JSON));
    expect(readLoginIdentity(join(dir, ".claude.json"))).toEqual({
      email: "owner@example.com",
      org: "Example Org",
    });
  });
});
