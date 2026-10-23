import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { tempDirForAll } from "./helpers/tmp";

const GATE = fileURLToPath(new URL("../scripts/validate-brief.sh", import.meta.url));
const NARRATION_BLOCK = readFileSync(
  new URL("../brief/NARRATION_BLOCK.txt", import.meta.url),
  "utf-8",
);
/** volleyd's spawn-brief templates: the briefs volleyd runs `$VOLLEYD_HOME/brief-gate` on. */
const VOLLEYD_BRIEFS = fileURLToPath(new URL("../../volleyd/briefs/", import.meta.url));

const tmp = tempDirForAll("validate-brief-");

function gate(brief: string): { code: number | null; out: string; err: string } {
  const file = join(tmp(), `brief-${Math.random().toString(36).slice(2)}.md`);
  writeFileSync(file, brief);
  const r = spawnSync("bash", [GATE, file], { encoding: "utf-8" });
  return { code: r.status, out: `${r.stdout}${r.stderr}`, err: r.stderr };
}

/** Fill every `{{name}}` the way volleyd's renderBrief does, with sample values. */
function render(template: string): string {
  return template.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (_m, name: string) =>
    name === "extra" ? "" : name === "issue" ? "101" : `sample-${name}`,
  );
}

const templates = readdirSync(VOLLEYD_BRIEFS).filter((f) => f.endsWith(".md.tmpl"));

describe("validate-brief.sh", () => {
  it("finds volleyd's role templates", () => {
    expect(templates.sort()).toEqual([
      "fixup.md.tmpl",
      "flake-fixer.md.tmpl",
      "implementer.md.tmpl",
      "integrator.md.tmpl",
      "quality_reviewer.md.tmpl",
      "rebase-merge.md.tmpl",
      "rebase.md.tmpl",
      "release.md.tmpl",
      "spec_reviewer.md.tmpl",
    ]);
  });

  it.each(templates)("passes volleyd's rendered %s (usable as volleyd's brief-gate)", (t) => {
    const r = gate(render(readFileSync(join(VOLLEYD_BRIEFS, t), "utf-8")));
    expect(r.out).toContain("validate-brief: OK");
    expect(r.code).toBe(0);
  });

  it("fails a volleyd brief whose narration paragraph was removed", () => {
    const brief = render(readFileSync(join(VOLLEYD_BRIEFS, "implementer.md.tmpl"), "utf-8"))
      .split("\n")
      .filter((l) => !/narration|once a minute/i.test(l))
      .join("\n");
    const r = gate(brief);
    expect(r.code).toBe(1);
    expect(r.out).toContain("MISSING");
  });

  it("passes a hand-written brief with vol_register and the narration block", () => {
    const brief = `Implement #5.\n\n1. vol_register with capabilities=["implements-issue"].\n\n${NARRATION_BLOCK}`;
    expect(gate(brief).code).toBe(0);
  });

  it("warns (but passes) when a hand-written brief's vol_register carries no title", () => {
    const brief = `Implement #5.\n\n1. vol_register with capabilities=["implements-issue"].\n\n${NARRATION_BLOCK}`;
    const r = gate(brief);
    expect(r.code).toBe(0);
    expect(r.out).toContain("validate-brief: OK");
    expect(r.err).toContain("WARNING: vol_register without title");
  });

  it("does not warn when the vol_register step carries a title", () => {
    const brief = `Implement #5.\n\n1. Call vol_register with capabilities=[\\"implements-issue\\"], title=\\"#5 Cache prefetch — implementer\\", links={ repo: \\"example/repo\\", issue: 5 }.\n\n${NARRATION_BLOCK}`;
    const r = gate(brief);
    expect(r.code).toBe(0);
    expect(r.err).not.toContain("WARNING");
  });

  it("does not warn when the vol_register call spreads its title over the next lines", () => {
    const brief = `Implement #5.\n\n1. Call vol_register with\n   capabilities=[\\"implements-issue\\"],\n   title=\\"#5 Cache prefetch — implementer\\".\n\n${NARRATION_BLOCK}`;
    const r = gate(brief);
    expect(r.code).toBe(0);
    expect(r.err).not.toContain("WARNING");
  });

  it.each(templates)("does not warn about a title on volleyd's rendered %s", (t) => {
    const r = gate(render(readFileSync(join(VOLLEYD_BRIEFS, t), "utf-8")));
    expect(r.code).toBe(0);
    expect(r.err).not.toContain("WARNING: vol_register without title");
  });

  it("fails a hand-written brief missing the narration contract", () => {
    const r = gate('Implement #5.\n\n1. vol_register with capabilities=["implements-issue"].\n');
    expect(r.code).toBe(1);
    expect(r.out).toContain('narration on the progress channel (channel="progress")');
    expect(r.out).toContain("final progress:100 tick");
    expect(r.out).toContain("NOT dispatching");
  });

  it("fails a hand-written brief with narration but no registration step", () => {
    const r = gate(`Implement #5.\n\n${NARRATION_BLOCK}`);
    expect(r.code).toBe(1);
    expect(r.out).toContain("vol_register");
  });
});
