import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { pairedHosts } from "../src/paired-hosts";
import { tempDir } from "./helpers/tmp";

describe("pairedHosts", () => {
  it("lists each paired machine with its hosts entry's target and volley_dir, by name", () => {
    const home = tempDir("volleyd-paired-");
    const at = "2026-10-01T00:00:00.000Z";
    writeFileSync(
      join(home, "peers.json"),
      JSON.stringify({
        peers: {
          zeta: { target: "dev@zeta", joined_at: at },
          athena: { target: "dev@athena-old", joined_at: at },
          gone: { target: "dev@gone", joined_at: at },
          nodir: { target: "dev@nodir", joined_at: at },
          leaving: { target: "dev@leaving", joined_at: at },
        },
        removing: { leaving: { by: "admin", mode: "drain", at } },
      }),
    );
    writeFileSync(
      join(home, "config.yaml"),
      [
        "hosts:",
        "  athena:",
        "    target: dev@athena",
        "    volley_dir: /path/to/volley",
        "  zeta:",
        "    volley_dir: /path/to/zeta/volley",
        "  nodir:",
        "    target: dev@nodir",
        "  leaving:",
        "    target: dev@leaving",
        "    volley_dir: /path/to/volley",
        "  byhand:",
        "    target: dev@byhand",
        "    volley_dir: /path/to/volley",
        "",
      ].join("\n"),
    );
    expect(pairedHosts(home)).toEqual({
      hosts: [
        { name: "athena", target: "dev@athena", volley_dir: "/path/to/volley" },
        { name: "zeta", target: "dev@zeta", volley_dir: "/path/to/zeta/volley" },
      ],
      problems: [
        { name: "gone", why: "no hosts.gone in config.yaml" },
        { name: "nodir", why: "hosts.nodir has no volley_dir" },
      ],
    });
  });

  it("no peers.json is no paired machine; an unreadable config.yaml is a problem per machine", () => {
    const home = tempDir("volleyd-paired-");
    expect(pairedHosts(home)).toEqual({ hosts: [], problems: [] });
    writeFileSync(
      join(home, "peers.json"),
      JSON.stringify({ peers: { athena: { target: "dev@athena", joined_at: "x" } } }),
    );
    writeFileSync(join(home, "config.yaml"), "hosts: [\n");
    const r = pairedHosts(home);
    expect(r.hosts).toEqual([]);
    expect(r.problems[0]?.name).toBe("athena");
    expect(r.problems[0]?.why).toContain("config.yaml");
  });
});
