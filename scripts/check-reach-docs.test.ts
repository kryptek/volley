import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Docs guard for v0.13 (Getting started, reach from anywhere, the coordinator as a role): the
 * owner smoke `docs/SMOKE-v0.13.md` keeps its four parts, Pass lines, metrics and run history,
 * and the user-facing docs tell the same story: the Quickstart ends in Getting started, the
 * README says how to reach Volley from anywhere, the Desk README shows the wizard's screenshots,
 * and the status paragraph names the smoke.
 */

const ROOT = join(import.meta.dir, "..");
const read = (f: string) => readFileSync(join(ROOT, f), "utf8");

/** The text from heading `start` up to the next heading of the same level (or the end). */
function section(text: string, start: string): string {
  const at = text.indexOf(start);
  if (at < 0) return "";
  const level = (start.match(/^#+/) ?? ["##"])[0];
  const rest = text.slice(at + start.length);
  const next = rest.search(new RegExp(`^${level} `, "m"));
  return next < 0 ? text.slice(at) : text.slice(at, at + start.length + next);
}

describe("docs/SMOKE-v0.13.md", () => {
  const smoke = read("docs/SMOKE-v0.13.md");
  const parts = [
    "## Part A — Getting started",
    "## Part B — Reach from anywhere",
    "## Part C — The coordinator",
    "## Part D — It survives",
  ];

  test("has parts A–D, each with numbered steps, Pass lines and a run history", () => {
    for (const p of parts) {
      const body = section(smoke, p);
      const letter = p.slice("## Part ".length, "## Part ".length + 1);
      expect({ p, found: body.length > 0 }).toEqual({ p, found: true });
      expect({ p, steps: new RegExp(`^### ${letter}1\\. `, "m").test(body) }).toEqual({
        p,
        steps: true,
      });
      expect({ p, pass: body.includes("**Pass:**") }).toEqual({ p, pass: true });
      expect({ p, history: body.includes(`### ${letter}. Run history`) }).toEqual({
        p,
        history: true,
      });
    }
  });

  test("starts each part from what you need, with checkboxes", () => {
    expect(smoke).toContain("### A0. What you need");
    expect(smoke).toMatch(/^- \[ \] /m);
  });

  test("the results table carries the three metrics for the tag annotation", () => {
    const results = section(smoke, "## Results");
    expect(results).toContain("Install to finished");
    expect(results).toContain("Kill to new link");
    expect(results).toContain("Cellular Desk load");
    expect(results).toMatch(/tag annotation/);
  });

  test("names machines by role and uses documentation addresses only", () => {
    expect(smoke).toContain("the always-on machine");
    expect(smoke).toContain("the laptop");
    expect(smoke).toContain("the phone");
    // MagicDNS names are example.ts.net; IPv4 literals are RFC 5737 or loopback.
    for (const m of smoke.matchAll(/\b[\w-]+\.ts\.net\b/g))
      expect(m[0]).toMatch(/example\.ts\.net$/);
    for (const m of smoke.matchAll(/\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}\b/g)) {
      const ok = /^(192\.0\.2|198\.51\.100|203\.0\.113)\.|^127\./.test(m[0]);
      expect({ ip: m[0], ok }).toEqual({ ip: m[0], ok: true });
    }
  });

  test("SMOKE.md's header points at it as the release's owner smoke", () => {
    const header = read("SMOKE.md").split("\n---\n")[0] ?? "";
    expect(header).toContain("[`docs/SMOKE-v0.13.md`](docs/SMOKE-v0.13.md)");
  });
});

describe("the reach-from-anywhere docs", () => {
  test("the Quickstart's last step is Getting started in the Desk", () => {
    const qs = section(read("README.md"), "## Quickstart");
    const steps = section(qs, "**When it finishes**") || qs;
    expect(steps).toContain("Getting started");
  });

  test("the README's Reach it from anywhere links INSTALL, the Desk and the coordinator role", () => {
    const reach = section(read("README.md"), "### Reach it from anywhere");
    expect(reach.length).toBeGreaterThan(0);
    expect(reach).toContain("docs/INSTALL.md#reach-it-from-outside-your-network");
    expect(reach).toContain("packages/volley-desk/README.md#on-your-private-network");
    expect(reach).toContain("packages/volleyd/README.md#the-coordinator-role");
  });

  test("docs/INSTALL.md says the installer ends in Getting started and the wizard adds machines", () => {
    const install = read("docs/INSTALL.md");
    expect(section(install, "## What the installer does")).toContain("Getting started");
    expect(section(install, "## Add a bare machine")).toContain("Your machines");
    expect(section(install, "## Reach it from outside your network")).toContain(
      "volley desk install --tailscale",
    );
  });

  test("the Desk README's Getting started shows Welcome, Machines, Access and Done, dark and light", () => {
    const gs = section(read("packages/volley-desk/README.md"), "## Getting started");
    for (const png of [
      "getting-started-welcome-dark.png",
      "getting-started-welcome.png",
      "getting-started-machines-light.png",
      "getting-started-machines.png",
      "getting-started-access-dark.png",
      "getting-started-access-light.png",
      "getting-started-done-light.png",
      "getting-started-done.png",
    ]) {
      expect({ png, linked: gs.includes(`(docs/${png})`) }).toEqual({ png, linked: true });
      expect({ png, exists: existsSync(join(ROOT, "packages/volley-desk/docs", png)) }).toEqual({
        png,
        exists: true,
      });
    }
  });

  test("CLAUDE.md's status names the release smoke; AUTOPILOT.md has the coordinator role", () => {
    const status =
      read("CLAUDE.md")
        .split("\n")
        .find((l) => l.startsWith("**Status:**")) ?? "";
    expect(status).toContain("docs/SMOKE-v0.13.md");
    const presence = section(read("docs/AUTOPILOT.md"), "## Presence: nothing to keep alive");
    expect(presence).toContain("coordinator role");
    expect(presence).toContain("volley coordinator");
  });
});
