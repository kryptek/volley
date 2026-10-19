/**
 * Fresh ids for the Desk's requests (correlation ids, steering message ids):
 * RFC 4122 version 4 UUIDs, which the envelope's `correlation_id` requires and
 * which also fit the reply topic's `[A-Za-z0-9_-]{8,64}`.
 *
 * `crypto.randomUUID` exists only in a secure context (https, localhost), and a
 * phone opening the Desk at `http://<lan address>:5199` is not one: calling it
 * there throws. `crypto.getRandomValues` exists on every page, so every
 * transport's default id comes from here.
 */
export function newId(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  // Version 4 (random) and the RFC 4122 variant.
  b[6] = ((b[6] as number) & 0x0f) | 0x40;
  b[8] = ((b[8] as number) & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
