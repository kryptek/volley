/**
 * The CLI's I/O surface, injected into every subcommand so tests can capture output
 * and freeze wall-clock without spawning a process or stubbing the global `process`.
 */
export interface IO {
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  now: () => Date;
}

export interface BufferIO extends IO {
  readStdout: () => string;
  readStderr: () => string;
}

/** Process-bound `IO` — what `cli.ts` uses in real execution. */
export const realIO: IO = {
  stdout: (s) => process.stdout.write(s),
  stderr: (s) => process.stderr.write(s),
  now: () => new Date(),
};

/** In-memory `IO` for unit tests — captures everything written and lets tests inject a clock. */
export function makeBufferIO(opts: { now?: () => Date } = {}): BufferIO {
  let out = "";
  let err = "";
  return {
    stdout: (s) => {
      out += s;
    },
    stderr: (s) => {
      err += s;
    },
    now: opts.now ?? (() => new Date()),
    readStdout: () => out,
    readStderr: () => err,
  };
}
