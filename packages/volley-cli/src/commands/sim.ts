import { resetWorld, simEnvLine, simHome } from "volley-sim/env";
import { EXIT, type ExitCode } from "../exit-codes";
import type { IO } from "../io";

/**
 * `volley sim`: the simulator (packages/volley-sim) — fake `claude` and `gh` an installed Volley
 * runs a whole wave against without an account. `env` prints the line a shell `eval`s to turn
 * it on; `reset` clears the simulated world.
 */

const HELP = `Usage:
  volley sim env      Print the line that turns the simulator on in this shell:
                        eval "$(volley sim env)"
                      (the fake claude and gh first on PATH, VOLLEY_SIM_HOME, VOLLEY_SIMULATED=1)
  volley sim reset    Clear the simulated world (its PRs, issues, runs, sign-ins and origins)

The world lives in $VOLLEY_SIM_HOME (default: ~/.volley/sim).
`;

export interface SimArgs {
  argv: string[];
  env: Record<string, string | undefined>;
  io: IO;
}

export async function sim(args: SimArgs): Promise<ExitCode> {
  const [verb, ...rest] = args.argv;
  if (verb === "--help" || verb === "-h") {
    args.io.stdout(HELP);
    return EXIT.OK;
  }
  if (rest.length > 0 || (verb !== "env" && verb !== "reset")) {
    args.io.stderr(
      verb === undefined ? HELP : `volley sim: unknown argument: ${args.argv.join(" ")}\n\n${HELP}`,
    );
    return EXIT.USAGE;
  }
  const home = simHome(args.env);
  if (verb === "env") {
    args.io.stdout(`${simEnvLine(home)}\n`);
    return EXIT.OK;
  }
  const removed = resetWorld(home);
  args.io.stdout(
    removed.length > 0
      ? `Cleared the simulated world in ${home} (${removed.join(", ")}).\n`
      : `The simulated world in ${home} is already empty.\n`,
  );
  return EXIT.OK;
}
