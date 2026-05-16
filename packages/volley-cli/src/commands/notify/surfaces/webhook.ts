import type { IO } from "../../../io";
import type { Surface } from "./types";

/** Loose `fetch` type — lets tests pass `vi.fn()` without `unknown` casts. */
export type WebhookFetchFn = (
  input: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal: AbortSignal;
  },
) => Promise<Response>;

export interface CreateWebhookSurfaceOpts {
  io: IO;
  url: string;
  fetch?: WebhookFetchFn;
}

const TIMEOUT_MS = 5000;
const ERROR_BODY_TRUNCATE = 200;

const defaultFetch: WebhookFetchFn = (input, init) => globalThis.fetch(input, init);

export function createWebhookSurface(opts: CreateWebhookSurfaceOpts): Surface {
  const { io, url } = opts;
  const fetchFn = opts.fetch ?? defaultFetch;

  return {
    name: "webhook",
    async fire({ topic, envelope }) {
      try {
        const res = await fetchFn(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ topic, envelope }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (!res.ok) {
          let body = "";
          try {
            body = await res.text();
          } catch {
            // body read failure is itself non-fatal — keep the status visible
          }
          io.stderr(
            `[notify] webhook returned ${res.status}: ${body.slice(0, ERROR_BODY_TRUNCATE)}\n`,
          );
        }
      } catch (e) {
        io.stderr(`[notify] webhook failed: ${e instanceof Error ? e.message : String(e)}\n`);
      }
    },
  };
}
