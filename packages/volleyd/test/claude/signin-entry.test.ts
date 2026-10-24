import { describe, expect, it } from "vitest";
import { parseSigninEntry, redact } from "../../src/claude/signin-entry";

describe("parseSigninEntry", () => {
  it("one token that is not an address is a code (trimmed)", () => {
    expect(parseSigninEntry("abc123#def")).toEqual({ kind: "code", code: "abc123#def" });
    expect(parseSigninEntry("  abc123 ")).toEqual({ kind: "code", code: "abc123" });
    expect(parseSigninEntry("abc123\n")).toEqual({ kind: "code", code: "abc123" });
  });

  it("a localhost callback address is a redirect, its query kept byte for byte", () => {
    expect(parseSigninEntry("http://localhost:51051/callback?code=abc&state=xyz")).toEqual({
      kind: "redirect",
      port: 51051,
      query: "code=abc&state=xyz",
    });
    expect(parseSigninEntry(" http://127.0.0.1:51051/callback?state=xyz&code=abc ")).toEqual({
      kind: "redirect",
      port: 51051,
      query: "state=xyz&code=abc",
    });
    expect(parseSigninEntry("http://localhost:51051/callback?code=a%2Bb&state=x%3Dy")).toEqual({
      kind: "redirect",
      port: 51051,
      query: "code=a%2Bb&state=x%3Dy",
    });
  });

  it("anything else is invalid", () => {
    for (const text of [
      "",
      "   ",
      "abc def",
      "https://claude.com/cai/oauth/authorize?code=true",
      "https://localhost:51051/callback?code=abc&state=xyz",
      "http://evil.example.com:51051/callback?code=abc&state=xyz",
      "http://localhost/callback?code=abc&state=xyz",
      "http://localhost:51051/other?code=abc&state=xyz",
      "http://localhost:51051/callback?state=xyz",
      "http://localhost:51051/callback?code=abc",
      "http://localhost:80/callback?code=abc&state=xyz",
      "http://localhost:51051/callback?code=abc&state=xyz#frag",
      "http://localhost:51051/callback?code=a'b&state=xyz",
      "-rf",
      "abc\u0007",
      "x".repeat(2049),
    ])
      expect(parseSigninEntry(text), JSON.stringify(text)).toEqual({ kind: "invalid" });
  });
});

describe("redact", () => {
  it("hides every code= and state= value", () => {
    const out = redact("curl: (22) http://127.0.0.1:51051/callback?code=abc&state=xyz failed");
    expect(out).not.toContain("abc");
    expect(out).not.toContain("xyz");
    expect(out).toContain("code=•••&state=•••");
  });

  it("hides the bare code it is given wherever it appears", () => {
    const out = redact("Invalid code abc123#def, try again", ["abc123#def"]);
    expect(out).toBe("Invalid code •••, try again");
  });

  it("leaves a message with nothing secret as it is", () => {
    expect(redact("Invalid code")).toBe("Invalid code");
  });
});
