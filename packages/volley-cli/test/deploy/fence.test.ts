import { describe, expect, it } from "vitest";
import { deployFence } from "../../src/deploy/fence";
import { type Ref, deployPlan, platformServices, readOnlyCommands } from "../../src/deploy/plan";

const repo = "/srv/volley";
const bun = "/opt/bun";

for (const platform of ["darwin", "linux"] as const) {
  describe(`deployFence (${platform})`, () => {
    const services = platformServices(platform, 501) ?? [];
    const fence = deployFence({ repo, bun, services });
    const ctx = { repo, bun, services, deskPort: 5199 };
    const targets: Ref[] = [
      { kind: "tag", name: "v0.5.0" },
      { kind: "tag", name: "v0.5.0-rc.1" },
      { kind: "branch", name: "release/2026-10-20-x" },
      { kind: "commit", name: "0123456789abcdef0123456789abcdef01234567" },
    ];

    it("allows every command the plan runs", () => {
      for (const target of targets) {
        const steps = deployPlan({
          ...ctx,
          target,
          fetch: true,
          stash: "volley-deploy-2026-10-20T14-05-09Z",
        });
        for (const c of [...readOnlyCommands(repo), ...steps.flatMap((s) => s.commands)]) {
          expect(
            () => fence(c.argv, c.cwd !== undefined ? { cwd: c.cwd } : {}),
            c.argv.join(" "),
          ).not.toThrow();
        }
      }
    });

    it("refuses everything else", () => {
      const refused: [string[], string?][] = [
        [["git", "-C", repo, "push"]],
        [["git", "-C", repo, "push", "origin", "v0.5.0"]],
        [["git", "-C", repo, "reset", "--hard"]],
        [["git", "-C", repo, "checkout", "--", "."]],
        [["git", "-C", repo, "checkout", "."]],
        [["git", "-C", repo, "clean", "-fd"]],
        [["git", "-C", repo, "checkout", "--detach", "-x"]],
        [["git", "-C", repo, "checkout", "-x"]],
        [["git", "-C", repo, "checkout", "-x", "--"]],
        [["git", "-C", repo, "checkout", "main"]],
        [["git", "-C", repo, "checkout", "main", "--", "a.ts"]],
        [["git", "-C", repo, "checkout", "--detach", "v0.5.0", "--force"]],
        [["git", "-C", "/elsewhere", "status", "--porcelain"]],
        [["git", "-C", "/elsewhere", "checkout", "--detach", "v0.5.0"]],
        [["git", "-C", repo, "stash", "push", "-u", "-m", "mine"]],
        [["git", "-C", repo, "stash", "drop"]],
        [["git", "-C", repo, "fetch", "--tags", "evil"]],
        [["rm", "-rf", repo]],
        [[bun, "install"], repo],
        [[bun, "install", "--frozen-lockfile"], "/elsewhere"],
        [[bun, "run", "build"], repo],
        [["/other/bun", "run", "build"], `${repo}/packages/volley-desk`],
        [[bun, `${repo}/packages/volley-cli/src/cli.ts`, "setup"]],
        [[bun, `${repo}/packages/volleyd/src/cli.ts`, "validate", "/tmp/x.yaml"]],
        [["launchctl", "bootout", "gui/501/systems.volley.volleyd"]],
        [["launchctl", "kickstart", "-k", "gui/501/com.example.other"]],
        [["systemctl", "--user", "stop", "volleyd.service"]],
        [["systemctl", "--user", "restart", "mosquitto.service"]],
      ];
      for (const [argv, cwd] of refused) {
        expect(() => fence(argv, cwd !== undefined ? { cwd } : {}), argv.join(" ")).toThrow(
          /volley deploy does not run/,
        );
      }
    });
  });
}
