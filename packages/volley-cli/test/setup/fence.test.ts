import { describe, expect, it } from "vitest";
import { fencedExec, listenerUrls, setupFence } from "../../src/setup/step";

describe("setupFence", () => {
  const fence = setupFence({
    restart: "brew services restart mosquitto",
    repoRoot: "/repo",
    bun: "/usr/local/bin/bun",
  });
  const desk = "/repo/packages/volley-desk";

  it.each([
    [["brew", "services", "restart", "mosquitto"]],
    [["launchctl", "print", "gui/501/systems.volley.desk"]],
    [["launchctl", "bootout", "gui/501/systems.volley.desk"]],
    [["launchctl", "bootstrap", "gui/501", "/home/u/Library/LaunchAgents/x.plist"]],
    [["systemctl", "--user", "daemon-reload"]],
    [["systemctl", "--user", "enable", "volleyd.service"]],
    [["systemctl", "--user", "restart", "volley-desk.service"]],
    [["systemctl", "--user", "is-active", "volleyd.service"]],
    [["security", "find-generic-password", "-s", "volley-broker", "-a", "coordinator", "-w"]],
    [["security", "-i"]],
    [["bash", "/repo/packages/volley-hooks/scripts/install.sh"]],
    [["bash", "/repo/packages/volley-hooks/scripts/install.sh", "--dry-run"]],
    [["/usr/local/bin/bun", "/repo/packages/volleyd/src/cli.ts", "install", "--dry-run"]],
  ])("allows %j", (argv) => {
    expect(() => fence(argv)).not.toThrow();
  });

  it("allows the Desk build only in the Desk's directory", () => {
    expect(() => fence(["/usr/local/bin/bun", "run", "build"], { cwd: desk })).not.toThrow();
    expect(() => fence(["/usr/local/bin/bun", "run", "build"], { cwd: "/elsewhere" })).toThrow();
    expect(() => fence(["/usr/local/bin/bun", "run", "build"])).toThrow();
  });

  it.each([
    [["rm", "-rf", "/"]],
    [["sh", "-c", "brew services restart mosquitto"]],
    [["brew", "services", "stop", "mosquitto"]],
    [["launchctl", "remove", "x"]],
    [["systemctl", "stop", "mosquitto"]],
    [["systemctl", "--user", "disable", "volleyd.service"]],
    [["security", "add-generic-password", "-s", "x", "-a", "y", "-w", "secret"]],
    [["security", "-i", "extra"]],
    [["security", "delete-generic-password", "-s", "volley-broker"]],
    [["bash", "/tmp/evil.sh"]],
    [["bash", "/repo/packages/volley-hooks/scripts/install.sh", "--uninstall"]],
    [["/usr/local/bin/bun", "/repo/packages/volleyd/src/cli.ts", "daemon"]],
    [["/usr/local/bin/bun", "-e", "process.exit(0)"]],
  ])("refuses %j", (argv) => {
    expect(() => fence(argv)).toThrow(/volley setup does not run/);
  });

  it("allows nothing of the checkout's when there is none", () => {
    const bare = setupFence({
      restart: "sudo systemctl restart mosquitto",
      repoRoot: null,
      bun: "bun",
    });
    expect(() => bare(["sudo", "systemctl", "restart", "mosquitto"])).not.toThrow();
    expect(() => bare(["bash", "null/packages/volley-hooks/scripts/install.sh"])).toThrow();
  });

  it("fencedExec refuses before the command is spawned", async () => {
    const ran: string[][] = [];
    const exec = fencedExec(async (argv) => {
      ran.push([...argv]);
      return { code: 0, stdout: "", stderr: "" };
    }, fence);
    await expect(exec(["rm", "-rf", "/"])).rejects.toThrow(/volley setup does not run `rm -rf \/`/);
    await exec(["systemctl", "--user", "daemon-reload"]);
    expect(ran).toEqual([["systemctl", "--user", "daemon-reload"]]);
  });
});

describe("listenerUrls", () => {
  it("is the broker's two listeners: the URL itself and ws://<host>:9001", () => {
    expect(listenerUrls("mqtt://127.0.0.1:1883")).toEqual({
      tcpUrl: "mqtt://127.0.0.1:1883",
      wsUrl: "ws://127.0.0.1:9001",
    });
    expect(listenerUrls("tcp://[::1]:1883")).toEqual({
      tcpUrl: "tcp://[::1]:1883",
      wsUrl: "ws://[::1]:9001",
    });
  });

  it("says why a URL setup cannot probe is refused", () => {
    expect(listenerUrls("nope")).toEqual({ error: "not a broker URL: nope" });
    expect(listenerUrls("mqtts://h:8883")).toEqual({
      error: "TLS is not supported by `volley setup` yet (got mqtts://h:8883)",
    });
    expect(listenerUrls("http://h")).toEqual({
      error: "the broker URL must be mqtt:// (got http://h)",
    });
  });
});
