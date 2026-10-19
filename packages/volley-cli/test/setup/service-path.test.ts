import { describe, expect, it } from "vitest";
import { isEphemeralDir, stableServicePath } from "../../src/setup/service-path";

const HOME = "/Users/someone";

/** A fake filesystem: the files that exist. */
const fs = (...files: string[]) => {
  const set = new Set(files);
  return (p: string) => set.has(p);
};

describe("stableServicePath", () => {
  it("is the fixed list when the shell has nothing else: no shell PATH entry is baked in", () => {
    expect(
      stableServicePath({
        home: HOME,
        bun: "/opt/homebrew/bin/bun",
        path: "/opt/homebrew/bin:/some/project/node_modules/.bin:/usr/bin:/bin",
        exists: fs("/opt/homebrew/bin", "/opt/homebrew/bin/bun"),
      }),
    ).toBe(`${HOME}/.volley/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`);
  });

  it("is the same from two shells with different PATHs (an ephemeral cmux shim dir included)", () => {
    const exists = fs(
      "/opt/homebrew/bin",
      `${HOME}/.bun/bin/bun`,
      `${HOME}/.local/bin/claude`,
      "/opt/homebrew/bin/gh",
      "/var/folders/xy/abc/T/cmux-cli-shims/1234-5678/cmux",
      "/Applications/cmux.app/Contents/Resources/bin",
      "/Applications/cmux.app/Contents/Resources/bin/cmux",
    );
    const inCmux = stableServicePath({
      home: HOME,
      bun: `${HOME}/.bun/bin/bun`,
      path: `/var/folders/xy/abc/T/cmux-cli-shims/1234-5678:${HOME}/.local/bin:${HOME}/.bun/bin:/opt/homebrew/bin:/usr/bin:/bin`,
      tmpdir: "/var/folders/xy/abc/T/",
      exists,
    });
    const otherTerminal = stableServicePath({
      home: HOME,
      bun: `${HOME}/.bun/bin/bun`,
      path: `/usr/bin:/bin:/opt/homebrew/bin:${HOME}/.bun/bin:/var/folders/xy/abc/T/cmux-cli-shims/9999-0000:${HOME}/.local/bin:/usr/sbin`,
      exists,
    });
    expect(inCmux).toBe(otherTerminal);
    expect(inCmux).toBe(
      [
        `${HOME}/.volley/bin`,
        `${HOME}/.bun/bin`,
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "/Applications/cmux.app/Contents/Resources/bin",
        `${HOME}/.local/bin`,
        "/usr/bin",
        "/bin",
        "/usr/sbin",
        "/sbin",
      ].join(":"),
    );
    expect(inCmux).not.toContain("cmux-cli-shims");
    expect(inCmux).not.toContain("/var/folders");
  });

  it("is idempotent: computed from its own output, it is unchanged", () => {
    const exists = fs(
      `${HOME}/.bun/bin/bun`,
      `${HOME}/.local/bin/claude`,
      `${HOME}/tools/bin/gh`,
      `${HOME}/tools/bin/claude`,
      "/usr/bin/git",
    );
    const first = stableServicePath({
      home: HOME,
      bun: `${HOME}/.bun/bin/bun`,
      // gh is only in tools/bin, claude in both: claude's first hit (.local/bin) is kept.
      path: `${HOME}/.local/bin:${HOME}/tools/bin:/usr/bin:/bin`,
      exists,
    });
    expect(first.split(":")).toContain(`${HOME}/.local/bin`);
    expect(first.split(":")).toContain(`${HOME}/tools/bin`);
    expect(
      stableServicePath({ home: HOME, bun: `${HOME}/.bun/bin/bun`, path: first, exists }),
    ).toBe(first);
  });

  it("adds no directory for a tool the fixed list already reaches", () => {
    const p = stableServicePath({
      home: HOME,
      bun: "bun",
      path: `${HOME}/.local/bin:/usr/bin:/bin`,
      exists: fs(`${HOME}/.local/bin/git`, "/usr/bin/git"),
    });
    expect(p).toBe(`${HOME}/.volley/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`);
  });

  it("never takes a relative or temporary bun directory", () => {
    for (const bun of ["bun", "./bun", "/tmp/bun-123/bun", "/private/var/folders/a/b/T/bun"]) {
      expect(stableServicePath({ home: HOME, bun, path: "", exists: fs() })).toBe(
        `${HOME}/.volley/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
      );
    }
  });
});

describe("isEphemeralDir", () => {
  it("knows temporary and per-session directories", () => {
    expect(isEphemeralDir("/var/folders/xy/abc/T/cmux-cli-shims/1234")).toBe(true);
    expect(isEphemeralDir("/private/var/folders/xy/abc/T/x")).toBe(true);
    expect(isEphemeralDir("/tmp/x")).toBe(true);
    expect(isEphemeralDir("/home/u/.cache/cmux-cli-shims/abc")).toBe(true);
    expect(isEphemeralDir("/scratch/tmpdir/x", "/scratch/tmpdir")).toBe(true);
    expect(isEphemeralDir("relative/bin")).toBe(true);
    expect(isEphemeralDir("/opt/homebrew/bin")).toBe(false);
    expect(isEphemeralDir(`${HOME}/.local/bin`)).toBe(false);
  });
});
