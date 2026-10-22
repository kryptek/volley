import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loginIdentity } from "../../src/peer/checks/claude";

const source = (rel: string) => readFileSync(new URL(`../../../${rel}`, import.meta.url), "utf-8");

/** The code between the regex and the copy's end marker, which the two packages share. */
const sharedCode = (text: string) => {
  const from = text.indexOf("const EMAIL =");
  const to = text.indexOf("// End of the copy shared with");
  if (from < 0 || to < 0) throw new Error("shared-copy markers not found");
  return text.slice(from, to);
};

describe("loginIdentity (volley-cli's copy)", () => {
  it("drops an address machine.schema.json's format: email rejects", () => {
    for (const emailAddress of ["ü@x.co", "a..b@x.co", "a(b@x.co", "a@-x.co", "a@x_y.co"])
      expect(loginIdentity({ oauthAccount: { emailAddress } })).toEqual({});
    expect(
      loginIdentity({ oauthAccount: { emailAddress: "First.Last+tag@Sub.Example.io" } }),
    ).toEqual({ email: "first.last+tag@sub.example.io" });
  });

  it("is the same code as volleyd's src/claude/identity.ts", () => {
    expect(sharedCode(source("volley-cli/src/peer/checks/claude.ts"))).toBe(
      sharedCode(source("volleyd/src/claude/identity.ts")),
    );
  });
});
