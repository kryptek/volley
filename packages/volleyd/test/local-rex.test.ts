import { describe, expect, it } from "vitest";
import { CONFIG_DEFAULTS, DAEMON_DEFAULTS } from "../src/config-defaults";
import {
  FenceError,
  REX_GLOBAL,
  REX_SCREEN_FORMAT,
  mintConsentToken,
  mintHandoffToken,
  mintModelSwitchToken,
  mintPickerToken,
  mintWakeToken,
  sealLaunchScript,
} from "../src/fence";
import { LocalRexHost, parseRexNew, parseRexSessions, rexTail } from "../src/hosts/local-rex";
import { LAUNCH_COMMAND, renderLaunchScript } from "../src/launch";
import { WAKE_TEXT } from "../src/liveness";
import type { SpawnError } from "../src/spawn-error";
import { fakeExec } from "./helpers/fake-exec";

/** A launch script volleyd would render, sealed for `cwd` (the fence starts it only so). */
const sealed = (cwd: string) =>
  sealLaunchScript(
    cwd,
    renderLaunchScript({
      hooksDir: "/opt/volley/packages/volley-hooks",
      model: "claude-opus-5-5",
      agentId: "w1-t1-implementer-1",
      worktree: cwd,
    }),
  );

const LABEL = "volley-w1-T1-implementer";
const SID = "session:11111111-2222-3333-4444-555555555555";
const SID2 = "session:99999999-8888-7777-6666-555555555555";
const BID = "block:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const BID2 = "block:ffffffff-bbbb-cccc-dddd-eeeeeeeeeeee";
const REX = ["rex", ...REX_GLOBAL];
const spec = (cwd = "/wt/x") => ({
  cwd,
  name: "w1 T1 implementer",
  command: LAUNCH_COMMAND,
  launch: sealed(cwd),
});
const newAnswer = JSON.stringify({
  session_id: SID,
  initial_windows: [{ window_id: "window:1", block_ids: [BID] }],
});
const ls = (...sessions: [string, string][]) => ({
  stdout: JSON.stringify({
    sessions: sessions.map(([session_id, label]) => ({ session_id, label })),
  }),
});
const NO_SERVER = {
  code: 4,
  stderr:
    "error: no Rex server is running at /path/to/home/.rex/rex.sock, and autostart is disabled",
};
const size = (columns: number, rows: number, owner: string | null = null) => ({
  stdout: JSON.stringify({ columns, rows, owner }),
});
/** A host that launched SID (so its block is known), and the fake behind it. */
async function launched() {
  const fake = fakeExec()
    .on([...REX, "ls"], ls())
    .on([...REX, "new"], { stdout: newAnswer })
    .on([...REX, "block", "call", "-s", SID, "-b", BID, "size"], size(220, 50));
  const host = new LocalRexHost(fake.exec);
  await host.launch(spec());
  fake.calls.length = 0;
  return { fake, host };
}

describe("the Rex answers", () => {
  it("parseRexNew: the session id and its first block", () => {
    expect(parseRexNew(newAnswer)).toEqual({ session: SID, block: BID });
    expect(parseRexNew("not json")).toBeNull();
    expect(parseRexNew(JSON.stringify({ session_id: "nope" }))).toBeNull();
    // A session with no block id still names the session (the block is resolved later).
    expect(parseRexNew(JSON.stringify({ session_id: SID, initial_windows: [] }))).toEqual({
      session: SID,
      block: null,
    });
  });

  it("parseRexSessions: every session's id and label", () => {
    expect(parseRexSessions(ls([SID, LABEL], [SID2, "other"]).stdout)).toEqual([
      { session_id: SID, label: LABEL },
      { session_id: SID2, label: "other" },
    ]);
    expect(parseRexSessions(JSON.stringify([{ session_id: SID, label: LABEL }]))).toEqual([
      { session_id: SID, label: LABEL },
    ]);
    expect(parseRexSessions("garbage")).toBeNull();
  });

  it("rexTail: the last n rows, trailing blank rows dropped", () => {
    expect(rexTail("a\nb\nc\n\n  \n", 2)).toBe("b\nc");
    expect(rexTail("a\r\nb\r\n", 5)).toBe("a\nb");
    expect(rexTail("", 3)).toBe("");
  });
});

describe("LocalRexHost", () => {
  it("is the local host, reading screens as rex", () => {
    const host = new LocalRexHost(fakeExec().exec);
    expect(host.name).toBe("local");
    expect(host.screenSource).toBe("rex");
  });

  it("launch opens a labelled session running the sealed launch script, then sizes it", async () => {
    const fake = fakeExec()
      .on([...REX, "ls"], ls([SID2, "someone else's"]))
      .on([...REX, "new"], { stdout: newAnswer });
    const r = await new LocalRexHost(fake.exec).launch(spec());
    expect(r).toEqual({ workspace: SID });
    const cols = CONFIG_DEFAULTS.tmux_cols;
    const rows = CONFIG_DEFAULTS.tmux_rows;
    expect(fake.argvs()).toEqual([
      [...REX, "ls", "--json"],
      [...REX, "new", LABEL, "-c", "/wt/x", "--json", "--", "bash", ".volley/launch.sh"],
      [
        ...REX,
        "block",
        "call",
        "-s",
        SID,
        "-b",
        BID,
        "resize",
        `{"columns":${cols},"rows":${rows}}`,
      ],
    ]);
    expect(fake.calls[1]?.opts.timeoutMs).toBe(DAEMON_DEFAULTS.launch_timeout_ms);
    expect(fake.calls[1]?.opts.launch).toBeDefined();
  });

  it("a label already in use falls back to -2, -3, … (Rex labels are not unique)", async () => {
    const fake = fakeExec()
      .on([...REX, "ls"], ls([SID2, LABEL]))
      .on([...REX, "new"], { stdout: newAnswer });
    await new LocalRexHost(fake.exec).launch(spec());
    expect(fake.argvs([...REX, "new"])[0]?.[REX.length + 1]).toBe(`${LABEL}-2`);
  });

  it("launch takes the spawn's size, inside the fence's bounds", async () => {
    const fake = fakeExec()
      .on([...REX, "ls"], ls())
      .on([...REX, "new"], { stdout: newAnswer });
    await new LocalRexHost(fake.exec).launch({ ...spec(), size: { cols: 9999, rows: 50.4 } });
    expect(fake.argvs([...REX, "block", "call"])[0]?.at(-1)).toBe('{"columns":500,"rows":50}');
  });

  it("refuses the coordinator, any other command, and a launch without its seal", async () => {
    const fake = fakeExec().on([...REX, "ls"], ls());
    const host = new LocalRexHost(fake.exec);
    const fail = async (s: Parameters<LocalRexHost["launch"]>[0]) =>
      (await host.launch(s).catch((e: unknown) => e)) as SpawnError;
    const coordinator = await fail({
      ...spec(),
      // Any coordinator token: the coordinator runs in tmux on every machine.
      coordinator: {} as never,
    });
    expect(coordinator.code).toBe("LAUNCH_FAILED");
    expect(coordinator.detail.outcome).toBe("refused");
    const other = await fail({ ...spec(), command: "bash -c id" });
    expect(other.code).toBe("LAUNCH_FAILED");
    expect(other.detail.outcome).toBe("refused");
    const unsealed = await fail({
      cwd: "/wt/x",
      name: "w1 T1 implementer",
      command: LAUNCH_COMMAND,
    });
    expect(unsealed.code).toBe("LAUNCH_FAILED");
    expect(unsealed.detail.outcome).toBe("refused");
    expect(fake.argvs([...REX, "new"])).toEqual([]);
  });

  it("a missing rex (ENOENT) is refused, saying where it lives and how to add it", async () => {
    const enoent = () => {
      throw Object.assign(new Error("spawn rex ENOENT"), { code: "ENOENT" });
    };
    for (const fake of [
      fakeExec().on(["rex"], enoent),
      fakeExec()
        .on([...REX, "ls"], ls())
        .on([...REX, "new"], enoent),
    ]) {
      const err = (await new LocalRexHost(fake.exec)
        .launch(spec())
        .catch((e: unknown) => e)) as SpawnError;
      expect(err.code).toBe("LAUNCH_FAILED");
      expect(err.detail.outcome).toBe("refused");
      expect(err.message).toContain("com.superlogical.rex/RexServer/Versions/Current");
      expect(err.message).toContain("volley setup --step terminal");
      expect(err.message).toContain("--step services");
      expect(err.message).toContain("PATH");
    }
  });

  it("no Rex server: refused, saying to open Rex and that nothing was created", async () => {
    for (const fake of [
      fakeExec().on([...REX, "ls"], NO_SERVER),
      fakeExec()
        .on([...REX, "ls"], ls())
        .on([...REX, "new"], NO_SERVER),
    ]) {
      const err = (await new LocalRexHost(fake.exec)
        .launch(spec())
        .catch((e: unknown) => e)) as SpawnError;
      expect(err.code).toBe("LAUNCH_FAILED");
      expect(err.detail.outcome).toBe("refused");
      expect(err.message).toContain("open Rex");
      expect(err.message).toContain("rex server start");
      expect(err.message).toContain("nothing was created");
    }
  });

  it("a launch that may have run is unknown, with the label it tried", async () => {
    const outcome = async (reply: Parameters<ReturnType<typeof fakeExec>["on"]>[1]) => {
      const fake = fakeExec()
        .on([...REX, "ls"], ls())
        .on([...REX, "new"], reply);
      const err = (await new LocalRexHost(fake.exec)
        .launch(spec())
        .catch((e: unknown) => e)) as SpawnError;
      expect(err.code).toBe("LAUNCH_FAILED");
      expect(err.detail.candidate).toBe(LABEL);
      return err.detail.outcome;
    };
    expect(await outcome({ code: 1, timedOut: true })).toBe("unknown");
    expect(await outcome({ code: 0, stdout: "OK" })).toBe("unknown");
    expect(
      await outcome(() => {
        throw new Error("spawn failed");
      }),
    ).toBe("unknown");
    expect(
      await outcome(() => {
        throw new FenceError("rex new", "not permitted for volleyd");
      }),
    ).toBe("refused");
    // Only ENOENT and exit 4 prove nothing ran: an exit whose text merely mentions a missing
    // command may still have created the session, so spawn reconciles.
    expect(await outcome({ code: 1, stderr: "bash: claude: command not found" })).toBe("unknown");
  });

  it("serializes launches: one new in flight at a time", async () => {
    let release = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let n = 0;
    const fake = fakeExec()
      .on([...REX, "ls"], ls())
      .on([...REX, "new"], async () => {
        n += 1;
        if (n === 1) await gate;
        return { stdout: newAnswer };
      });
    const host = new LocalRexHost(fake.exec);
    const first = host.launch(spec());
    const second = host.launch(spec());
    for (let i = 0; i < 200; i++) await Promise.resolve();
    expect(fake.argvs([...REX, "new"])).toHaveLength(1);
    release();
    await first;
    await second;
    expect(fake.argvs([...REX, "new"])).toHaveLength(2);
    fake.on([...REX, "new"], { code: 1, stderr: "boom" });
    await expect(host.launch(spec())).rejects.toThrow("LAUNCH_FAILED");
    fake.on([...REX, "new"], { stdout: newAnswer });
    expect(await host.launch(spec())).toEqual({ workspace: SID });
  });

  it("findWorkspace: the one session with the label; none is null, two throw", async () => {
    const fake = fakeExec().on([...REX, "ls"], ls([SID, LABEL], [SID2, "other"]));
    const host = new LocalRexHost(fake.exec);
    expect(await host.findWorkspace("w1 T1 implementer")).toBe(SID);
    expect(fake.argvs()[0]).toEqual([...REX, "ls", "--json"]);
    expect(await host.findWorkspace("w1 T1 implementer", "other")).toBe(SID2);
    expect(await host.findWorkspace("w1 T2 implementer")).toBeNull();
    fake.on([...REX, "ls"], ls([SID, LABEL], [SID2, LABEL]));
    await expect(host.findWorkspace("w1 T1 implementer")).rejects.toThrow(/2 Rex sessions/);
    // Rex not answering is undecidable.
    fake.on([...REX, "ls"], NO_SERVER);
    await expect(host.findWorkspace("w1 T1 implementer")).rejects.toThrow();
    fake.on([...REX, "ls"], { code: 1, timedOut: true });
    await expect(host.findWorkspace("w1 T1 implementer")).rejects.toThrow();
  });

  it("readScreen: one bounded format call when the screen fits", async () => {
    const { fake, host } = await launched();
    fake.on([...REX, "block", "call", "-s", SID, "-b", BID, "format"], {
      stdout: JSON.stringify({ content: "a\nb\nc\n\n" }),
    });
    expect(await host.readScreen(SID, 2)).toBe("b\nc");
    expect(fake.argvs()).toEqual([
      [...REX, "block", "call", "-s", SID, "-b", BID, "format", REX_SCREEN_FORMAT],
    ]);
    expect(REX_SCREEN_FORMAT).toBe('{"format":"text","trim":true,"max_bytes":65536}');
    expect(fake.calls[0]?.opts.timeoutMs).toBe(DAEMON_DEFAULTS.screen_read_timeout_ms);
  });

  it("readScreen: the tail through blob_read at total - 65536 when more remains", async () => {
    const { fake, host } = await launched();
    fake
      .on([...REX, "block", "call", "-s", SID, "-b", BID, "format"], {
        stdout: JSON.stringify({ content: "old\n", total: 100_000, id: 7 }),
      })
      .on([...REX, "block", "call", "-s", SID, "-b", BID, "blob_read"], {
        stdout: JSON.stringify({ data: "x\ny\nz\n" }),
      });
    expect(await host.readScreen(SID, 2)).toBe("y\nz");
    expect(fake.argvs()[1]).toEqual([
      ...REX,
      "block",
      "call",
      "-s",
      SID,
      "-b",
      BID,
      "blob_read",
      '{"id":7,"offset":34464,"max_bytes":65536}',
    ]);
  });

  it("readScreen is null on any failure, never a throw", async () => {
    const { fake, host } = await launched();
    const format = [...REX, "block", "call", "-s", SID, "-b", BID, "format"];
    fake.on(format, { code: 4, stderr: NO_SERVER.stderr });
    expect(await host.readScreen(SID, 5)).toBeNull();
    fake.on(format, { timedOut: true, code: 1 });
    expect(await host.readScreen(SID, 5)).toBeNull();
    fake.on(format, { stdout: "not json" });
    expect(await host.readScreen(SID, 5)).toBeNull();
    fake.on(format, () => {
      throw new Error("spawn failed");
    });
    expect(await host.readScreen(SID, 5)).toBeNull();
    fake.on(format, { stdout: JSON.stringify({ content: "", total: 9, id: 1 }) });
    fake.on([...REX, "block", "call", "-s", SID, "-b", BID, "blob_read"], { code: 1 });
    expect(await host.readScreen(SID, 5)).toBeNull();
    // A blob id with no total: the tail's offset is unknown, so no screen rather than its head.
    fake.on(format, { stdout: JSON.stringify({ content: "", id: 1 }) });
    fake.on([...REX, "block", "call", "-s", SID, "-b", BID, "blob_read"], {
      stdout: JSON.stringify({ data: "head\n" }),
    });
    expect(await host.readScreen(SID, 5)).toBeNull();
    // Not a Rex session ref at all.
    expect(await host.readScreen("workspace:3", 5)).toBeNull();
  });

  it("a session it did not launch (a restart) finds its block once, through session inspect", async () => {
    const inspect = {
      session_id: SID,
      windows: [
        {
          window_id: "window:1",
          layers: [
            {
              blocks: [
                { block_id: BID2, creator_name: "com.example.other" },
                { block_id: BID, creator_name: "com.superlogical.terminal" },
              ],
            },
          ],
        },
      ],
    };
    const fake = fakeExec()
      .on([...REX, "session", "inspect"], { stdout: JSON.stringify(inspect) })
      .on([...REX, "block", "call"], { stdout: JSON.stringify({ content: "hi\n" }) });
    const host = new LocalRexHost(fake.exec);
    expect(await host.readScreen(SID, 5)).toBe("hi");
    expect(await host.readScreen(SID, 5)).toBe("hi");
    expect(fake.argvs([...REX, "session"])).toEqual([
      [...REX, "session", "inspect", SID, "--json"],
    ]);
    expect(fake.argvs([...REX, "block"])[0]?.slice(REX.length + 2, REX.length + 6)).toEqual([
      "-s",
      SID,
      "-b",
      BID,
    ]);
  });

  it("sendKeys maps the host's key names to Rex's, with the tokens", async () => {
    const { fake, host } = await launched();
    await host.sendKeys(SID, "Enter");
    await host.sendKeys(SID, "Escape");
    const picker = mintPickerToken({ item_id: "p-1", version: 1, keys: ["Up", "Down", "Space"] });
    for (const k of ["Up", "Down", "Space"]) await host.sendKeys(SID, k, { picker });
    expect(fake.argvs().map((a) => a.at(-1))).toEqual(["enter", "esc", "up", "down", "space"]);
    expect(fake.argvs()[0]).toEqual([...REX, "send-key", "-s", SID, "-b", BID, "enter"]);
    expect(fake.calls[0]?.opts.timeoutMs).toBe(DAEMON_DEFAULTS.send_keys_timeout_ms);
    await expect(host.sendKeys(SID, "Down")).rejects.toThrow(FenceError);
    await expect(host.sendKeys(SID, "C-c")).rejects.toThrow();
  });

  it("sendText types after `--`, with the tokens the fence needs", async () => {
    const { fake, host } = await launched();
    const modelSwitch = mintModelSwitchToken("claude-sonnet-5-5", "d-1");
    await host.sendText(SID, "/model claude-sonnet-5-5", { modelSwitch });
    const handoff = mintHandoffToken({ item_id: "h-1", version: 1, text: "-yes, go" });
    await host.sendText(SID, "-yes, go", { handoff });
    await host.sendText(SID, WAKE_TEXT, { wake: mintWakeToken() });
    expect(fake.argvs()).toEqual([
      [...REX, "send", "-s", SID, "-b", BID, "--", "/model claude-sonnet-5-5"],
      [...REX, "send", "-s", SID, "-b", BID, "--", "-yes, go"],
      [...REX, "send", "-s", SID, "-b", BID, "--", WAKE_TEXT],
    ]);
    await expect(host.sendText(SID, "rm -rf /")).rejects.toThrow(FenceError);
    fake.on([...REX, "send"], { code: 3, stderr: "block not found" });
    await expect(host.sendText(SID, WAKE_TEXT, { wake: mintWakeToken() })).rejects.toThrow(
      /exit 3/,
    );
  });

  it("resize reads the size back: true when Rex applied it, false when a client kept its own", async () => {
    const { fake, host } = await launched();
    fake.on([...REX, "block", "call", "-s", SID, "-b", BID, "size"], size(120, 40));
    expect(await host.resize(SID, { cols: 120, rows: 40 })).toBe(true);
    expect(fake.argvs()).toEqual([
      [...REX, "block", "call", "-s", SID, "-b", BID, "resize", '{"columns":120,"rows":40}'],
      [...REX, "block", "call", "-s", SID, "-b", BID, "size"],
    ]);
    fake.on([...REX, "block", "call", "-s", SID, "-b", BID, "size"], size(80, 24, "client:1"));
    expect(await host.resize(SID, { cols: 120, rows: 40 })).toBe(false);
    // Back to its launch size.
    fake.calls.length = 0;
    await host.resize(SID, "launch");
    expect(fake.argvs()[0]?.at(-1)).toBe(
      `{"columns":${CONFIG_DEFAULTS.tmux_cols},"rows":${CONFIG_DEFAULTS.tmux_rows}}`,
    );
    fake.on([...REX, "block", "call", "-s", SID, "-b", BID, "resize"], { code: 4 });
    await expect(host.resize(SID, { cols: 120, rows: 40 })).rejects.toThrow();
  });

  it("close kills the session with consent; one already gone is closed", async () => {
    const { fake, host } = await launched();
    const consent = mintConsentToken("retire w1-t1-implementer-1");
    await host.close(SID, consent);
    expect(fake.argvs()).toEqual([[...REX, "kill", SID]]);
    expect(fake.calls[0]?.opts.timeoutMs).toBe(DAEMON_DEFAULTS.workspace_close_timeout_ms);
    fake.on([...REX, "kill"], { code: 3, stderr: `error: session target ${SID} not found` });
    await expect(host.close(SID, consent)).resolves.toBeUndefined();
    fake.on([...REX, "kill"], { code: 4, stderr: NO_SERVER.stderr });
    await expect(host.close(SID, consent)).rejects.toThrow();
    await expect(
      host.close(SID, undefined as unknown as Parameters<LocalRexHost["close"]>[1]),
    ).rejects.toThrow(/consent/);
  });

  it("endSession kills the session, then stops what still runs under the worktree", async () => {
    const { fake, host } = await launched();
    const consent = mintConsentToken("retire w1-t1-implementer-1");
    const end = await host.endSession(SID, "/wt/x", consent);
    expect(end).toEqual({ closed: true, pids: [], how: "kill-session" });
    expect(fake.argvs()[0]).toEqual([...REX, "kill", SID]);
    expect(fake.argvs()[1]?.[0]).toBe("ps");
    fake.on([...REX, "kill"], { code: 4, stderr: NO_SERVER.stderr });
    expect(await host.endSession(SID, null, consent)).toEqual({
      closed: false,
      pids: [],
      how: "none",
    });
  });
});
