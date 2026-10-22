import { describe, expect, it } from "vitest";
import { isEphemeralDir, stableServicePath } from "../../src/setup/service-path";

const HOME = "/path/to/home";

/** A fake filesystem: the files that exist. */
const fs = (...files: string[]) => {
  const set = new Set(files);
  return (p: string) => set.has(p);
};

describe("stableServicePath", () => {
  it("is the fixed list, each candidate kept only when it exists", () => {
    expect(
      stableServicePath({
        home: HOME,
        bun: "/opt/homebrew/bin/bun",
        exists: fs("/opt/homebrew/bin"),
      }),
    ).toBe(`${HOME}/.volley/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`);
  });

  it("takes nothing from the invoking shell: it has no PATH input at all", () => {
    const inputs = { home: HOME, bun: `${HOME}/.bun/bin/bun`, exists: fs() };
    const withPath = { ...inputs, path: `${HOME}/tools/bin:/some/project/node_modules/.bin` };
    expect(stableServicePath(withPath as typeof inputs)).toBe(stableServicePath(inputs));
  });

  it("on a Mac with Homebrew, cmux, claude's and bun's installers: every one, in a fixed order", () => {
    const exists = fs(
      "/opt/homebrew/bin",
      "/opt/homebrew/sbin",
      `${HOME}/.bun/bin`,
      `${HOME}/.local/bin`,
      `${HOME}/.claude/local`,
      "/Applications/cmux.app/Contents/Resources/bin",
    );
    expect(stableServicePath({ home: HOME, bun: `${HOME}/.bun/bin/bun`, exists })).toBe(
      [
        `${HOME}/.volley/bin`,
        `${HOME}/.bun/bin`,
        "/opt/homebrew/bin",
        "/opt/homebrew/sbin",
        "/usr/local/bin",
        "/Applications/cmux.app/Contents/Resources/bin",
        `${HOME}/.local/bin`,
        `${HOME}/.claude/local`,
        "/usr/bin",
        "/bin",
        "/usr/sbin",
        "/sbin",
      ].join(":"),
    );
  });

  it("on Linux: Linuxbrew, nix and snap when present", () => {
    const exists = fs("/home/linuxbrew/.linuxbrew/bin", "/snap/bin", `${HOME}/.nix-profile/bin`);
    expect(stableServicePath({ home: HOME, bun: "/usr/bin/bun", exists })).toBe(
      [
        `${HOME}/.volley/bin`,
        "/usr/bin",
        "/home/linuxbrew/.linuxbrew/bin",
        "/usr/local/bin",
        `${HOME}/.nix-profile/bin`,
        "/snap/bin",
        "/bin",
        "/usr/sbin",
        "/sbin",
      ].join(":"),
    );
  });

  it("never takes a relative or temporary bun directory", () => {
    for (const bun of ["bun", "./bun", "/tmp/bun-123/bun", "/private/var/folders/a/b/T/bun"]) {
      expect(stableServicePath({ home: HOME, bun, exists: fs() })).toBe(
        `${HOME}/.volley/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
      );
    }
    expect(
      stableServicePath({ home: HOME, bun: "/scratch/t/bun", tmpdir: "/scratch/t/", exists: fs() }),
    ).toBe(`${HOME}/.volley/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`);
  });
});

describe("isEphemeralDir", () => {
  it("knows temporary and per-session directories", () => {
    expect(isEphemeralDir("/var/folders/xy/abc/T/cmux-cli-shims/1234")).toBe(true);
    expect(isEphemeralDir("/private/var/folders/xy/abc/T/x")).toBe(true);
    expect(isEphemeralDir("/tmp/x")).toBe(true);
    expect(isEphemeralDir("/path/to/home/.cache/cmux-cli-shims/abc")).toBe(true);
    expect(isEphemeralDir("/scratch/tmpdir/x", "/scratch/tmpdir")).toBe(true);
    expect(isEphemeralDir("relative/bin")).toBe(true);
    expect(isEphemeralDir("/opt/homebrew/bin")).toBe(false);
    expect(isEphemeralDir(`${HOME}/.local/bin`)).toBe(false);
  });
});
