/**
 * The wave file view, ported from the prototype `WaveYaml`: the submitted
 * spec (the wave state's `spec`) rendered back as YAML, one flow mapping per
 * task with its title as a comment.
 */
import type { PipelineStep, WaveStatePayload } from "../../store/types";

/**
 * Task ids in wave-file order: the wave state's `tasks` array (ordered), then
 * any spec-only ids. Not `Object.keys(spec.tasks)`: integer-like ids such as
 * "10" and "2" would enumerate first, in numeric order.
 */
export function taskOrder(wave: WaveStatePayload): string[] {
  const ids = [...new Set(wave.tasks.map((t) => t.id))];
  const seen = new Set(ids);
  return [...ids, ...Object.keys(wave.spec?.tasks ?? {}).filter((id) => !seen.has(id))];
}

const flow = (steps: readonly PipelineStep[]): string =>
  `[${steps.map((s) => (Array.isArray(s) ? flow(s) : s)).join(", ")}]`;

const k = (s: string) => <span className="y-k">{s}</span>;
const v = (s: string) => <span className="y-v">{s}</span>;

export function WaveYaml({ wave }: { wave: WaveStatePayload }) {
  const spec = wave.spec;
  const specTasks = spec?.tasks ?? {};
  return (
    <pre className="yaml recessed" aria-label="Wave file">
      {k("wave")}: {v(wave.wave)}
      {"\n"}
      {k("release_branch")}: {v(spec?.release_branch ?? wave.release_branch)}
      {"\n"}
      {spec?.model && (
        <>
          {k("model")}: {v(spec.model)}
          {"\n"}
        </>
      )}
      {spec?.pipeline && (
        <>
          {k("pipeline")}: {v(flow(spec.pipeline))}
          {"\n"}
        </>
      )}
      {k("tasks")}:{"\n"}
      {taskOrder(wave).map((id) => {
        const t = specTasks[id];
        if (!t) return null;
        return (
          <span key={id}>
            {"  "}
            {k(id)}: {"{ "}
            {k("issue")}: {v(String(t.issue))}
            {t.after.length ? (
              <>
                , {k("after")}: [{v(t.after.join(", "))}]
              </>
            ) : null}
            {" }"}
            {t.title && (
              <span className="y-c">
                {"  # "}
                {t.title}
              </span>
            )}
            {"\n"}
          </span>
        );
      })}
    </pre>
  );
}
