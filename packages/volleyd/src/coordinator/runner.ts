import { DAEMON_DEFAULTS } from "../config-defaults";
import { mintCoordinatorKill, sealCoordinatorScript } from "../fence";
import type { CoordinatorConfig } from "../types";
import type { CoordinatorTarget } from "./prepare";
import {
  COORDINATOR_COMMAND,
  COORDINATOR_SETTINGS,
  type CoordinatorRolePayload,
  coordinatorSession,
  desiredState,
  expandDir,
  extractRemoteControlLink,
  nextBackoff,
  renderCoordinatorMcp,
  renderCoordinatorScript,
  screenPrompt,
} from "./role";

/** What the runner reads and does through the daemon (fakes in tests). */
export interface CoordinatorRunnerDeps {
  now: () => number;
  /** The effective `coordinator` tunables, read on every tick. */
  config: () => CoordinatorConfig;
  /** The coordinator name setup recorded (`setup.json` `coordinator`); null: none yet. */
  name: () => string | null;
  namespace: string;
  /** The machine as the runner drives it, or why it cannot. */
  target: (machine: string) => CoordinatorTarget | string;
  /** The machine's record is up (always for `local`). */
  up: (machine: string) => boolean;
  /** The coordinator login file's text, or null when the supervisor holds none. */
  login: () => string | null;
  /** The repositories the machine holds a clone of: `<dir>/repos/<owner>/<name>` links. */
  repos: (machine: string, home: string) => { slug: string; target: string }[];
  /** Publish the retained topic; null clears it (empty retained). */
  publish: (payload: CoordinatorRolePayload | null) => Promise<void>;
  /** The owner's `coordinator_stop`, kept across volleyd restarts until a `coordinator_restart`. */
  stopped: { get: () => boolean; set: (v: boolean) => void };
  log: (msg: string) => void;
}

/** Where the role runs now: the machine, its expanded dir and its session. */
interface Placed {
  machine: string;
  dir: string;
  name: string;
  session: string;
}

/**
 * The coordinator role's supervisor (SPEC §4.6.25): each `tick` compares what the config wants
 * (`coordinator.machine`, its machine up) with what runs (`has-session` on that machine) and
 * starts, restarts or stops the session; it publishes `volley/_system/federation/coordinator`
 * on every change. A start prepares the directory first. A death waits `restart_backoff_s`
 * (the ladder resets after a server that was up `coordinator_backoff_reset_s`); three deaths in
 * a row, each within the ladder's total of its start, are `failed` until `restart()`. volleyd's
 * own start adopts a session already running; its shutdown leaves the session alone.
 */
export class CoordinatorRunner {
  private placed: Placed | null = null;
  /** Sessions left behind (a machine change or `null`) whose kill failed: retried each pass. */
  private orphans: Placed[] = [];
  private payload: CoordinatorRolePayload | null = null;
  /** The topic was published (or cleared) since this runner started. */
  private published = false;
  private deaths = 0;
  private quick = 0;
  private startedAt = 0;
  private nextStartAt = 0;
  /** We launched it (or adopted it) and saw it running: a missing session is a death. */
  private launched = false;
  private lastScreen = "";
  private readAt = 0;
  private running: Promise<void> | null = null;

  constructor(private readonly deps: CoordinatorRunnerDeps) {}

  /** The payload as last published (null: the role is off or not known yet). */
  status(): CoordinatorRolePayload | null {
    return this.payload;
  }

  /** One pass; a pass already running is not started again (it is returned). */
  tick(): Promise<void> {
    this.running ??= this.pass().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  /** `coordinator_restart`: end the session (if any), clear the backoff and the stop, start again. */
  async restart(): Promise<CoordinatorRolePayload | null> {
    await this.running;
    this.deps.stopped.set(false);
    // Not ours to count: a pass during the kill must not take the session's end for a death.
    this.launched = false;
    if (this.placed !== null) await this.killPlaced(this.placed);
    this.reset();
    // Back to a fresh start: the next pass launches it (`starting`) with no restarts counted.
    if (this.payload !== null) this.payload = { ...this.payload, state: "stopped", restarts: 0 };
    await this.tick();
    return this.payload;
  }

  /** `coordinator_stop`: end the session and keep it stopped until `restart()`. */
  async stop(): Promise<CoordinatorRolePayload | null> {
    await this.running;
    this.deps.stopped.set(true);
    this.launched = false;
    if (this.placed !== null) await this.killPlaced(this.placed);
    this.reset();
    await this.tick();
    return this.payload;
  }

  private reset(): void {
    this.deaths = 0;
    this.quick = 0;
    this.nextStartAt = 0;
    this.launched = false;
    this.lastScreen = "";
  }

  private async pass(): Promise<void> {
    await this.sweep();
    const cfg = this.deps.config();
    const name = this.deps.name();
    const want = desiredState({
      machine: name === null ? null : cfg.machine,
      up: cfg.machine !== null && this.deps.up(cfg.machine),
    });
    if (want === "off") {
      if (cfg.machine !== null && name === null)
        this.deps.log("coordinator: no coordinator name recorded by volley setup; nothing runs");
      if (this.placed !== null) await this.retire(this.placed);
      this.placed = null;
      this.reset();
      await this.set(null);
      return;
    }
    const machine = cfg.machine as string;
    const coord = name as string;
    // A machine (or dir) change: the old session goes first, then the new one starts afresh.
    if (
      this.placed !== null &&
      (this.placed.machine !== machine || this.placed.name !== coord || !this.dirMatches(cfg))
    ) {
      await this.retire(this.placed);
      this.placed = null;
      this.reset();
      this.payload = null;
    }
    if (want === "waiting") {
      const why = `${machine} is not up`;
      const cur = this.payload;
      if (cur === null) await this.set(this.fresh(machine, coord, "stopped", why));
      else if (cur.state !== "failed" && (cur.state !== "stopped" || cur.last_error !== why)) {
        // Nothing reaches a server there: its link is not handed out while the machine is down.
        const { session_url: _u, needs_terminal: _n, ...rest } = cur;
        await this.set({ ...rest, state: "stopped", since: this.iso(), last_error: why });
      }
      // Back up, a session still there is adopted; one gone is started afresh, not a death.
      this.launched = false;
      return;
    }
    const target = this.deps.target(machine);
    if (typeof target === "string") {
      // Unchanged, it is not republished: `since` stays when it entered this state.
      const cur = this.payload;
      if (cur?.machine !== machine || cur.state !== "stopped" || cur.last_error !== target)
        await this.set(this.fresh(machine, coord, "stopped", target));
      return;
    }
    let placed = this.placed;
    if (placed === null) {
      const home = await target.home().catch((e: unknown) => {
        this.deps.log(`coordinator: ${String(e)}`);
        return null;
      });
      if (home === null) return;
      const dir = expandDir(cfg.dir, home);
      placed = { machine, dir, name: coord, session: coordinatorSession(coord) };
      this.placed = placed;
      this.home = home;
    }
    if (this.deps.stopped.get()) {
      // Stopped is reported only once no session runs: a kill that failed (or a session still
      // there after a volleyd restart) is killed on a later pass.
      let alive: boolean;
      try {
        alive = (await target.host.findWorkspace(placed.session, placed.session)) !== null;
      } catch (e) {
        this.deps.log(`coordinator: has-session on ${machine}: ${String(e)}`);
        return;
      }
      if (alive && !(await this.killPlaced(placed))) return;
      if (this.payload?.state !== "stopped" || this.payload.machine !== machine)
        await this.set({ ...this.base(placed), state: "stopped", since: this.iso() });
      return;
    }
    if (this.payload?.state === "failed") return;
    let alive: boolean;
    try {
      alive = (await target.host.findWorkspace(placed.session, placed.session)) !== null;
    } catch (e) {
      // The machine cannot be asked: undecidable, nothing is started or stopped.
      this.deps.log(`coordinator: has-session on ${machine}: ${String(e)}`);
      return;
    }
    if (alive) {
      await this.observe(target, placed);
      return;
    }
    if (this.launched) {
      await this.died(placed, cfg);
      return;
    }
    if (this.now() < this.nextStartAt) return;
    await this.start(target, placed, cfg);
  }

  private home = "";

  private dirMatches(cfg: CoordinatorConfig): boolean {
    return this.placed !== null && this.placed.dir === expandDir(cfg.dir, this.home);
  }

  /** The session is there: adopt it, read its screen for the link and any question it asks. */
  private async observe(target: CoordinatorTarget, placed: Placed): Promise<void> {
    if (!this.launched) {
      // volleyd's own restart (or a session started before it): adopted, as it is.
      this.launched = true;
      this.startedAt = this.now();
      if (this.payload === null || this.payload.state === "stopped")
        await this.set({ ...this.base(placed), state: "running", since: this.iso() });
    }
    const p = this.payload;
    // Until it runs with its link, every pass; then every coordinator_screen_read_ms, so a death
    // reports what the screen last showed.
    const settled = p !== null && p.state === "running" && p.session_url !== undefined;
    if (settled && this.now() - this.readAt < DAEMON_DEFAULTS.coordinator_screen_read_ms) return;
    this.readAt = this.now();
    const screen = await target.host
      .readScreen(placed.session, DAEMON_DEFAULTS.coordinator_screen_lines)
      .catch(() => null);
    if (screen !== null) this.lastScreen = screen;
    const link = screen !== null ? extractRemoteControlLink(screen) : null;
    const prompt = screen !== null ? screenPrompt(screen) : null;
    const waited = this.now() - this.startedAt >= DAEMON_DEFAULTS.coordinator_link_wait_ms;
    const cur = this.payload as CoordinatorRolePayload;
    if (link !== null) {
      const { needs_terminal: _n, last_error: _e, ...rest } = cur;
      await this.set({
        ...rest,
        state: "running",
        since: cur.state === "running" ? cur.since : this.iso(),
        session_url: link,
      });
    } else if (prompt !== null) {
      if (cur.needs_terminal !== prompt) {
        this.deps.log(
          `coordinator: the server on ${placed.machine} asks on its screen (${prompt}): attach with \`tmux attach -t ${placed.session}\` there and answer it`,
        );
        await this.set({
          ...cur,
          needs_terminal: prompt,
          last_error: `${prompt === "trust" ? "Claude Code asks whether to trust" : "Claude Code asks to enable Remote Control in"} ${placed.dir}: run \`tmux attach -t ${placed.session}\` on ${placed.machine} and answer it`,
        });
      }
    } else if (waited && cur.state !== "running") {
      // No link on its screen: the name is the handle (the phone lists the session by it).
      await this.set({ ...cur, state: "running", since: this.iso() });
    }
  }

  /** The session we ran is gone: back off, or fail after three quick deaths in a row. */
  private async died(placed: Placed, cfg: CoordinatorConfig): Promise<void> {
    const upForS = Math.floor((this.now() - this.startedAt) / 1000);
    const ladder = cfg.restart_backoff_s;
    const window = ladder.reduce((a, b) => a + b, 0);
    this.deaths = upForS >= DAEMON_DEFAULTS.coordinator_backoff_reset_s ? 1 : this.deaths + 1;
    this.quick = upForS < window ? this.quick + 1 : 0;
    this.launched = false;
    const restarts = (this.payload?.restarts ?? 0) + 1;
    const lines = this.lastScreen
      .split("\n")
      .filter((l) => l.trim() !== "")
      .slice(-DAEMON_DEFAULTS.coordinator_error_lines)
      .join("\n");
    const why =
      lines !== ""
        ? lines
        : `the session ${placed.session} on ${placed.machine} ended after ${upForS} s`;
    const prior = this.payload ?? {
      ...this.base(placed),
      state: "starting" as const,
      since: this.iso(),
    };
    const { session_url: _u, needs_terminal: _n, ...rest } = prior;
    if (this.quick >= 3) {
      this.deps.log(`coordinator: failed on ${placed.machine} after ${restarts} restarts: ${why}`);
      await this.set({ ...rest, state: "failed", since: this.iso(), restarts, last_error: why });
      return;
    }
    const waitS = nextBackoff(ladder, this.deaths, upForS);
    this.nextStartAt = this.now() + waitS * 1000;
    this.deps.log(`coordinator: the session on ${placed.machine} died; restarting in ${waitS} s`);
    await this.set({ ...rest, state: "restarting", since: this.iso(), restarts, last_error: why });
  }

  /** Prepare the directory on the machine, then launch the sealed script in its session. */
  private async start(
    target: CoordinatorTarget,
    placed: Placed,
    cfg: CoordinatorConfig,
  ): Promise<void> {
    const restarting = this.payload?.state === "restarting";
    // A start that fails is on the deaths' ladder: it waits its rung, three in a row are failed.
    const fail = async (e: unknown) => {
      const why = e instanceof Error ? e.message : String(e);
      this.deaths++;
      this.quick++;
      const base = { ...this.base(placed), since: this.iso(), last_error: why };
      if (this.quick >= 3) {
        this.deps.log(`coordinator: failed on ${placed.machine}: cannot start: ${why}`);
        await this.set({ ...base, state: "failed" });
        return;
      }
      const waitS = nextBackoff(cfg.restart_backoff_s, this.deaths, 0);
      this.nextStartAt = this.now() + waitS * 1000;
      this.deps.log(
        `coordinator: cannot start on ${placed.machine}: ${why}; trying again in ${waitS} s`,
      );
      await this.set({ ...base, state: restarting ? "restarting" : "stopped" });
    };
    const login = this.deps.login();
    if (login === null)
      return fail(
        new Error("the supervisor holds no coordinator login (coordinator.json): run volley setup"),
      );
    const vars = {
      dir: placed.dir,
      name: placed.name,
      namespace: this.deps.namespace,
      brokerPort: target.brokerPort,
      hooksDir: target.hooksDir,
      binDir: `${this.home}/.volley/bin`,
      capacity: cfg.capacity,
      permissionMode: cfg.permission_mode,
      continueGraceS: Math.ceil(DAEMON_DEFAULTS.coordinator_continue_grace_ms / 1000),
    };
    try {
      const script = renderCoordinatorScript(vars);
      const token = sealCoordinatorScript(placed.dir, script);
      await target.prepare(
        {
          dir: placed.dir,
          script,
          login,
          mcp: renderCoordinatorMcp(target.mcpEntry, vars),
          settings: COORDINATOR_SETTINGS,
          links: this.deps.repos(placed.machine, this.home),
        },
        token,
      );
      if (!restarting)
        await this.set({
          ...this.base(placed),
          state: "starting",
          since: this.iso(),
          restarts: this.payload?.restarts ?? 0,
        });
      // A session of this name left behind is this one now, not one to kill.
      this.orphans = this.orphans.filter(
        (o) => o.machine !== placed.machine || o.session !== placed.session,
      );
      await target.host.launch({
        cwd: placed.dir,
        name: placed.session,
        command: COORDINATOR_COMMAND,
        coordinator: token,
      });
    } catch (e) {
      return fail(e);
    }
    this.launched = true;
    this.startedAt = this.now();
    this.lastScreen = "";
  }

  /** End the session; false when it could not be (the machine unreachable, the kill refused). */
  private async killPlaced(placed: Placed): Promise<boolean> {
    const target = this.deps.target(placed.machine);
    if (typeof target === "string") {
      this.deps.log(`coordinator: kill-session on ${placed.machine}: ${target}`);
      return false;
    }
    return target.kill(placed.session, mintCoordinatorKill(placed.name)).then(
      () => true,
      (e: unknown) => {
        this.deps.log(`coordinator: kill-session on ${placed.machine}: ${String(e)}`);
        return false;
      },
    );
  }

  /** A placement given up: its session ends now, or is kept to retry until it does. */
  private async retire(placed: Placed): Promise<void> {
    if (await this.killPlaced(placed)) return;
    if (!this.orphans.some((o) => o.machine === placed.machine && o.session === placed.session))
      this.orphans.push(placed);
  }

  /** Retry the kill of every session left behind whose machine is up again. */
  private async sweep(): Promise<void> {
    const left: Placed[] = [];
    for (const o of this.orphans)
      if (!this.deps.up(o.machine) || !(await this.killPlaced(o))) left.push(o);
    this.orphans = left;
  }

  private base(placed: Placed): Omit<CoordinatorRolePayload, "state" | "since"> {
    return {
      machine: placed.machine,
      name: placed.name,
      restarts: this.payload?.restarts ?? 0,
      dir: placed.dir,
    };
  }

  /** A payload before (or without) a placement: `dir` only once it is expanded on that machine. */
  private fresh(
    machine: string,
    name: string,
    state: CoordinatorRolePayload["state"],
    lastError: string,
  ): CoordinatorRolePayload {
    const p: CoordinatorRolePayload = {
      machine,
      name,
      state,
      since: this.iso(),
      restarts: 0,
      last_error: lastError,
    };
    if (this.placed?.machine === machine) p.dir = this.placed.dir;
    return p;
  }

  /** Publish when it changed (or for the first time since this runner started). */
  private async set(next: CoordinatorRolePayload | null): Promise<void> {
    const same = JSON.stringify(next) === JSON.stringify(this.payload);
    this.payload = next;
    if (same && this.published) return;
    this.published = true;
    await this.deps.publish(next);
  }

  private now(): number {
    return this.deps.now();
  }

  private iso(): string {
    return new Date(this.now()).toISOString();
  }
}
