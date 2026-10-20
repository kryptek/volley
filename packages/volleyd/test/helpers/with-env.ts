type Vars = Record<string, string | undefined>;

/** Set `vars` in `process.env` (undefined: unset); returns what they were. */
function swap(vars: Vars): Vars {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) {
    // an unset variable must be absent: assigning undefined would set the string "undefined"
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return saved;
}

/** Set `vars` in `process.env` until the returned function puts each back as it was. */
export function stubEnv(vars: Vars): () => void {
  const saved = swap(vars);
  return () => {
    swap(saved);
  };
}

/**
 * Run `fn` with `vars` set in `process.env`, then put each back as it was. A plain save/restore
 * (no `vi.stubEnv`), so it works under both vitest and bun's test runner.
 */
export function withEnvSync<T>(vars: Vars, fn: () => T): T {
  const saved = swap(vars);
  try {
    return fn();
  } finally {
    swap(saved);
  }
}

/** `withEnvSync` for an async `fn`: restored once it settles. */
export async function withEnv<T>(vars: Vars, fn: () => Promise<T>): Promise<T> {
  const saved = swap(vars);
  try {
    return await fn();
  } finally {
    swap(saved);
  }
}
