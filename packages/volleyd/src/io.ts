/**
 * The CLI's I/O surface and exit codes — the same contract as volley-cli (0 ok, 1 error,
 * 2 usage, 69 supervisor unreachable, 124 timeout), injected into every command so tests
 * capture output in-process.
 */
export const EXIT = {
  OK: 0,
  ERROR: 1,
  USAGE: 2,
  /** `resolve` / `inbox answer`: an answer the decision cannot apply (code BAD_ANSWER). */
  BAD_ANSWER: 3,
  /** The supervisor does not answer: diagnosed, nothing submitted (volley-cli's table has it too). */
  SUPERVISOR_UNREACHABLE: 69,
  TIMEOUT: 124,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

export interface IO {
  stdout: (s: string) => void;
  stderr: (s: string) => void;
}

export const realIO: IO = {
  stdout: (s) => process.stdout.write(s),
  stderr: (s) => process.stderr.write(s),
};

export interface BufferIO extends IO {
  readStdout: () => string;
  readStderr: () => string;
}

export function makeBufferIO(): BufferIO {
  let out = "";
  let err = "";
  return {
    stdout: (s) => {
      out += s;
    },
    stderr: (s) => {
      err += s;
    },
    readStdout: () => out,
    readStderr: () => err,
  };
}

/** Arguments every command receives. */
export interface CommandArgs {
  argv: string[];
  env: Record<string, string | undefined>;
  io: IO;
}

export type Command = (args: CommandArgs) => Promise<ExitCode>;
