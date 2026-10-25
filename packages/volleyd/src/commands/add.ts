import { readFile as fsReadFile, writeFile as fsWriteFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { withSetupCoordinator } from "volley-cli/auth/coordinator-login";
import { DAEMON_DEFAULTS } from "../config-defaults";
import { type ControlTarget, resolveControlTarget, withClient } from "../control";
import { type ExecFn, exec as realExec } from "../exec";
import type { Tree } from "../footprint";
import { type Command, type CommandArgs, EXIT, type ExitCode } from "../io";
import { type IssueFacts, type IssueWhere, fetchIssueFacts } from "../issue";
import { parseIssueArg } from "../issue-task";
import { resolveCaller } from "../ownership";
import { type PlanDiff, formatDiff } from "../plan-diff";
import { isSlug } from "../repos";
import type { WaveState } from "../types";
import { type AddPlan, checkAdd, planAdd } from "../wave-add";
import { parseWaveFile } from "../wave-file";
import { expandHome } from "../worktree";
import { formatWave } from "./status";
import { planLines, waveTree as realWaveTree } from "./validate";

const HELP = `Usage: volleyd add <wave> <issue...> [--after <task,...>] [--file <wave.yaml>]
                   [--by <agent-id>] [--json] [--broker-url <url>] [--namespace <ns>]

Add issues to a running wave as new tasks, in one command (owner only): fetch each issue
(602, #602, or its issue URL), derive its task as wave-from-issues does (the title's tag, else
i<N>; after: from its Depends on: line; files: and footprint: from its Files list against the
release branch's tree), write it into the wave file and submit the file as the wave's next plan
version. --after adds existing task ids (comma-separated, or repeated) to every added task's
after:. The wave file is --file, else .volley/waves/<wave>.yaml under this directory; it must be
the plan the daemon runs (volleyd diff shows the difference otherwise), and only the new task
blocks are added to it. Refused, with the file untouched: a wave that is not live, an issue
already in it, a closed issue, a dependency outside the wave that is open (one that is closed or
labelled merged-to-release is satisfied). When the daemon refuses the version, the file is
restored. The caller is --by, else VOLLEY_AGENT_ID, else the session registered for this
directory, else VOLLEY_COORDINATOR, else the name volley setup saved.
`;

/** Statuses a wave takes nothing new in. */
const ENDED = new Set(["complete", "stopped", "releasing", "archived"]);

export interface AddDeps {
  exec: ExecFn;
  readFile: (path: string) => Promise<string>;
  writeFile: (path: string, text: string) => Promise<void>;
  waveTree: (repo: string, branch: string) => Promise<Tree | null>;
  /** Where the default `.volley/waves/<wave>.yaml` is looked for. */
  cwd: () => string;
}

/** `volleyd add` over `deps` (tests pass fakes; `add` is the real one). */
export function makeAdd(deps: AddDeps): Command {
  return async ({ argv, env, io }: CommandArgs): Promise<ExitCode> => {
    let parsed: ReturnType<typeof parseAdd>;
    let target: ControlTarget;
    try {
      parsed = parseAdd(argv);
      target = resolveControlTarget(parsed.values, env);
    } catch (e) {
      io.stderr(`volleyd add: ${e instanceof Error ? e.message : String(e)}\n${HELP}`);
      return EXIT.USAGE;
    }
    const v = parsed.values;
    if (v.help === true) {
      io.stdout(HELP);
      return EXIT.OK;
    }
    const [wave, ...args] = parsed.positionals;
    if (wave === undefined || args.length === 0) {
      io.stderr(`volleyd add: expected a wave id and at least one issue\n${HELP}`);
      return EXIT.USAGE;
    }
    const after = (v.after ?? []).flatMap((a) =>
      a
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s !== ""),
    );
    const file = v.file ?? join(deps.cwd(), ".volley", "waves", `${wave}.yaml`);
    let text: string;
    try {
      text = await deps.readFile(file);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        io.stderr(
          v.file !== undefined
            ? `volleyd add: no wave file at ${file}\n`
            : `volleyd add: no wave file at ${file} (run from the repository root, or pass --file <wave.yaml>)\n`,
        );
        return EXIT.USAGE;
      }
      io.stderr(`volleyd add: ${e instanceof Error ? e.message : String(e)}\n`);
      return EXIT.ERROR;
    }

    return withClient(target, io, "volleyd add", async (client) => {
      const fail = (msg: string, code: ExitCode = EXIT.ERROR) => {
        io.stderr(`volleyd add: ${msg}\n`);
        return code;
      };
      const who = await resolveCaller(
        client,
        typeof v.by === "string" ? v.by : undefined,
        withSetupCoordinator(env).env,
      );
      if (who.id === null) {
        return fail(
          "add needs an identity: pass --by <name|agent-id> or set VOLLEY_COORDINATOR or VOLLEY_AGENT_ID",
        );
      }
      if (who.warning !== undefined) io.stderr(`warning: ${who.warning}\n`);
      const caller = who.id;

      // The wave is live (a version of an ended one would be refused only after the edit).
      const st = await client.request("status", { wave });
      if (!st.ok) {
        return fail(
          `unknown wave '${wave}' (volleyd status lists them; a new wave starts with wave-from-issues + volleyd run)`,
        );
      }
      const state = st.result as WaveState & { archived?: unknown };
      const status = state.archived !== undefined ? "archived" : state.status;
      if (ENDED.has(status)) return fail(`wave '${wave}' is ${status}; nothing can be added to it`);
      const slug = state.github?.slug ?? (isSlug(state.repo) ? state.repo : undefined);

      let numbers: number[];
      try {
        numbers = [...new Set(args.map((a) => parseIssueArg(a, slug)))];
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e), EXIT.USAGE);
      }

      // The file is the plan the daemon runs: `add` changes one thing in it.
      try {
        parseWaveFile(text, file);
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
      }
      const d = await client.request("diff", { wave, wave_yaml: text, source: file });
      if (!d.ok) return fail(d.error ?? "diff failed");
      if (d.plan?.unchanged !== true) {
        const diff = d.result as PlanDiff;
        const changed = diff.changed.length > 0 ? ` / ~ ${diff.changed.length}` : "";
        return fail(
          `${file} differs from plan v${d.plan?.version ?? "?"} (+ ${diff.added.length} / - ${diff.removed.length}${changed}): submit it with volleyd run, or revert it, so that add changes one thing`,
        );
      }
      const pre = checkAdd({ text, wave, issues: numbers, after });
      if (pre !== null) return fail(pre.refused, pre.usage === true ? EXIT.USAGE : EXIT.ERROR);

      // gh by the repository's name when the daemon read one, else in its checkout.
      const where: IssueWhere = slug !== undefined ? { slug } : { cwd: expandHome(state.repo) };
      const facts = new Map<number, IssueFacts>();
      const issues: IssueFacts[] = [];
      try {
        for (const n of numbers) issues.push(await fetchIssueFacts(deps.exec, where, n));
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
      }
      const tree = await deps.waveTree(state.repo, state.release_branch);
      const input = {
        text,
        source: file,
        wave,
        issues,
        facts,
        after,
        tree,
        ...(slug !== undefined ? { slug } : {}),
      };
      let plan: AddPlan = planAdd(input);
      while ("need" in plan) {
        try {
          for (const n of plan.need) facts.set(n, await fetchIssueFacts(deps.exec, where, n));
        } catch (e) {
          return fail(e instanceof Error ? e.message : String(e));
        }
        plan = planAdd(input);
      }
      if ("refused" in plan)
        return fail(plan.refused, plan.usage === true ? EXIT.USAGE : EXIT.ERROR);

      // Write, then submit: a file behind the daemon's plan is the dangerous state (the next
      // innocent `volleyd run` would cancel the task); a refused submit restores the old bytes.
      await deps.writeFile(file, plan.text);
      const res = await client
        .request(
          "run",
          { wave_yaml: plan.text, source: file, owner: caller },
          {
            text: `volleyd add ${wave} ${args.join(" ")}`,
            timeoutMs: DAEMON_DEFAULTS.issue_fetch_ms + DAEMON_DEFAULTS.request_timeout_ms,
          },
        )
        .catch(async (e: unknown) => {
          // No answer: the daemon may have taken the version, so the file is kept as submitted.
          io.stderr(
            `volleyd add: no answer to the submit; ${file} is kept as submitted: check it with volleyd diff ${wave} ${file}\n`,
          );
          throw e;
        });
      if (!res.ok) {
        await deps.writeFile(file, text);
        io.stderr(`volleyd add: ${res.error ?? "rejected"}\nrestored ${file}\n`);
        return EXIT.ERROR;
      }
      const next = res.result as WaveState;
      const added = plan.added.map((t) => ({ id: t.id, issue: t.issue, after: t.after }));
      if (v.json === true) {
        io.stdout(`${JSON.stringify({ state: next, plan: res.plan, added, file }, null, 2)}\n`);
        return EXIT.OK;
      }
      const lines = [
        `submitted wave ${next.wave} plan v${res.plan?.version ?? "?"}\n`,
        res.plan !== undefined ? formatDiff(res.plan.diff) : "",
        ...plan.added.map(
          (t) =>
            `${t.id}: #${t.issue} ${JSON.stringify(t.title)} ${t.after.length > 0 ? `after [${t.after.join(", ")}]` : "after: none"}\n`,
        ),
        ...[...plan.warnings, ...(res.warnings ?? [])].map((w) => `warning: ${w}\n`),
        ...plan.notes.map((n) => `note: ${n}\n`),
        `wave file: ${file}\n`,
        ...(status === "paused"
          ? [
              `wave ${wave} is paused: ${plan.added.map((t) => t.id).join(", ")} ${plan.added.length > 1 ? "are" : "is"} queued and ${plan.added.length > 1 ? "start" : "starts"} on resume\n`,
            ]
          : []),
        planLines(parseWaveFile(plan.text, file), tree),
        formatWave(next, { decisions: res.plan?.decisions ?? [] }),
      ];
      io.stdout(lines.join(""));
      return EXIT.OK;
    });
  };
}

export const add: Command = makeAdd({
  exec: realExec,
  readFile: (path) => fsReadFile(path, "utf-8"),
  writeFile: (path, text) => fsWriteFile(path, text),
  waveTree: realWaveTree,
  cwd: () => process.cwd(),
});

function parseAdd(argv: string[]) {
  return parseArgs({
    args: argv,
    options: {
      after: { type: "string", multiple: true },
      file: { type: "string" },
      by: { type: "string" },
      json: { type: "boolean", default: false },
      "broker-url": { type: "string" },
      namespace: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
    allowPositionals: true,
  });
}
