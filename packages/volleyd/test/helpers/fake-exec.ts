import type { ExecFn, ExecOptions, ExecResult } from "../../src/exec";
import { assertAllowed } from "../../src/fence";

export interface ExecCall {
  argv: string[];
  opts: ExecOptions;
}

type Reply =
  | Partial<ExecResult>
  | ((argv: string[], opts: ExecOptions) => Partial<ExecResult> | Promise<Partial<ExecResult>>);

/**
 * A fake `exec` that records every argv and answers from scripted replies: the first rule whose
 * prefix matches the argv wins; unmatched commands succeed with empty output. Every argv still
 * passes the real authority fence first, so a test also proves the fence allows it.
 */
export interface FakeExec {
  exec: ExecFn;
  calls: ExecCall[];
  /** Reply to every argv starting with `prefix`. Later rules take precedence. */
  on: (prefix: string[], reply: Reply) => FakeExec;
  /** The argvs that started with `prefix`, in call order. */
  argvs: (prefix?: string[]) => string[][];
}

export function fakeExec(): FakeExec {
  const calls: ExecCall[] = [];
  const rules: { prefix: string[]; reply: Reply }[] = [];
  const starts = (argv: readonly string[], prefix: string[]) =>
    prefix.every((p, i) => argv[i] === p);
  const fake: FakeExec = {
    calls,
    exec: async (argv, opts = {}) => {
      assertAllowed(argv, opts);
      calls.push({ argv: [...argv], opts });
      const rule = [...rules].reverse().find((r) => starts(argv, r.prefix));
      const r =
        rule === undefined
          ? {}
          : typeof rule.reply === "function"
            ? await rule.reply([...argv], opts)
            : rule.reply;
      return { code: 0, stdout: "", stderr: "", timedOut: false, ...r };
    },
    on: (prefix, reply) => {
      rules.push({ prefix, reply });
      return fake;
    },
    argvs: (prefix = []) => calls.filter((c) => starts(c.argv, prefix)).map((c) => c.argv),
  };
  return fake;
}
