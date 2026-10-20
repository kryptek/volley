// Seed a private broker with one running wave (with agents), one stopped and one complete
// wave, and a live supervisor, for the coordinators and window-style checks. Run it from the
// repo root, against the private broker only:
//   bun packages/volley-desk/scripts/browser-check/seed-waves.mjs mqtt://127.0.0.1:<port>
import { readFileSync } from "node:fs";
import mqtt from "mqtt";

const url = process.argv[2];
if (!url) {
  console.error("usage: seed-waves.mjs <private broker mqtt url>");
  process.exit(2);
}
const example = new URL("../../../../spec/examples/valid/wave-state-running.json", import.meta.url);
const base = JSON.parse(readFileSync(example, "utf8"));
const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const env = (agent, channel, type, payload, at = now) => ({
  schema_version: "0.1",
  agent_id: agent,
  channel,
  type,
  wall_time: iso(at),
  namespace: "default",
  payload,
});
const wave = (id, status, owner, agentsOf) => ({
  ...base,
  wall_time: iso(now),
  payload: {
    ...base.payload,
    wave: id,
    owner,
    status,
    updated_at: iso(now),
    coordinator: {
      agent_id: owner,
      state: status === "running" ? "working" : "gone",
      last_seen: iso(now),
    },
    tasks: base.payload.tasks.map((t) => ({
      ...t,
      stage: status === "running" ? t.stage : "done",
      agents: agentsOf(t),
    })),
    gates: [],
  },
});
const recs = [];
const agent = (id, st) => {
  const reg = {
    capabilities: ["implements-issue"],
    cwd: "/work/repo",
    started_at: iso(now - 3600e3),
  };
  recs.push([`volley/_system/registry/${id}`, env(id, "_system/registry", "registered", reg)]);
  recs.push([`volley/default/${id}/status`, env(id, "status", st, {})]);
};
const implOf = (task, prefix) => (t) => (t.id === task ? { implementer: `${prefix}-impl` } : {});
recs.push([
  "volley/_waves/release-c/state",
  wave("release-c", "running", "coord-run", (t) =>
    t.id === "T2" ? {} : { implementer: `rc-${t.id.toLowerCase()}-impl` },
  ),
]);
agent("coord-run", "working");
agent("rc-t1-impl", "working");
agent("rc-t3-impl", "working");
recs.push([
  "volley/_waves/release-a/state",
  wave("release-a", "stopped", "coord-old-a", implOf("T1", "ra-t1")),
]);
agent("ra-t1-impl", "done");
recs.push([
  "volley/_waves/release-b/state",
  wave("release-b", "complete", "coord-old-b", implOf("T1", "rb-t1")),
]);
agent("rb-t1-impl", "done");
const supervisor = {
  capabilities: ["supervisor"],
  started_at: iso(now - 7200e3),
  version: "0.3.0",
};
recs.push([
  "volley/_system/registry/volleyd",
  env("volleyd", "_system/registry", "registered", supervisor),
]);
recs.push(["volley/default/volleyd/status", env("volleyd", "status", "working", { waves: 3 })]);

const c = await mqtt.connectAsync(url, { reconnectPeriod: 0 });
for (const [t, e] of recs) await c.publishAsync(t, JSON.stringify(e), { qos: 1, retain: true });
await c.endAsync();
console.log(`seeded ${recs.length} records`);
