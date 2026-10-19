# Dynamic Security spike: can Volley broker auth run on it?

**Question.** Volley broker auth today edits `password_file` + `acl_file` and SIGHUPs the
broker ([`examples/mosquitto-auth/`](../../examples/mosquitto-auth/README.md)). The plan is to
move it to the mosquitto **Dynamic Security plugin**: static per-role ACLs using `%u`
patterns, with per-agent clients created and deleted at runtime over
`$CONTROL/dynamic-security/v1`, while 50+ agents stay connected and the daemon creates and
deletes hundreds of clients a day. This spike measures whether that holds on both broker
versions in use, with a number or an observed behaviour per question.

**Answer: GO, with two conditions S5 must design for.**

1. **`%u` / `%c` are not supported on mosquitto 2.0.x.** The 2.0.22 plugin matches ACLs
   literally, so one static `agent` role cannot pin each agent to its own topics there. On 2.1.x
   the static role works exactly as intended. S5 must either require mosquitto ≥ 2.1 or create
   **one role per agent** with the id written into the topics. That role works on both versions
   and costs 7.3 ms per agent on 2.0.22 (1.9 ms on 2.1.2).
2. **Deleting or disabling a client kicks it without publishing its LWT.** The daemon must
   publish the agent's terminal (`reaped`) status itself after `deleteClient`.

Also required: the broker needs `set_tcp_nodelay true`, or every sequential control call takes
41 ms. Never edit a role that connected agents hold: an ACL change on a role disconnects every
client that holds it. Keep `per_listener_settings false`.

## Go / no-go

Measured on one Linux x86_64 workstation (16 cores, 60 GB RAM, Bun 1.3.14). **2.0.22** is the
distribution package (`mosquitto_dynamic_security.so` from the distro) run as a local process.
**2.1.2** is the official `eclipse-mosquitto:2.1.2-alpine` image, the version Homebrew ships
on macOS, on the host network. Both used `set_tcp_nodelay true`; latency is round-trip from
the Bun client. Full runs: `run-local.sh` and `run-2.1.sh`.

| Item | mosquitto 2.0.22 (Linux, distro) | mosquitto 2.1.2 (container) | Verdict |
|---|---|---|---|
| **(a)** Role ACLs with `%u` / `%c` | **Not substituted.** 0 of 4 allow-cases delivered (own status, own registry entry, `%c` topic, `_waves` caveat); the deny-cases were denied. Control case with the id written literally in a per-agent role: delivered. | **Works.** 10 of 10 cases pass: X publishes its own status and registry entry; X → `volley/<ns>/Y/mailbox`, Y's status and Y's registry entry are not delivered; `%c` substitutes the client id, not the username | 2.0: **NO-GO** for a static role, **GO** for per-agent roles. 2.1: **GO** |
| **(b)** `createClient`+`addClientRole` (one message), one control connection | c=1: p50 0.52 / p95 0.78 / p99 2.47 ms, 1,712/s · c=10: 4.1 / 6.8 / 7.9 ms, 2,300/s · c=50: 17.9 / 30.0 / 31.1 ms, 2,339/s · c=200: 86.9 / 196 / 207 ms, 1,348/s | c=1: 0.73 / 0.93 / 2.49 ms, 1,290/s · c=10: 6.7 / 8.1 / 9.0 ms, 1,532/s · c=50: 29.7 / 43.1 / 47.2 ms, 1,539/s · c=200: 132 / 199 / 211 ms, 1,185/s | **GO**: about 1,300 ops/s or more, against a need of hundreds per day |
| **(b)** `deleteClient`, one control connection | c=1: p50 0.28 / p99 2.18 ms, 3,144/s · c=200: 67.9 / 105 ms, 2,703/s | c=1: 0.35 / 2.08 ms, 2,624/s · c=200: 86.5 / 139 ms, 2,122/s | **GO** |
| **(b)** One control connection per worker | c=200: create p50 301 ms, 553/s (2.0) | c=200: create p50 339 ms, 534/s | Slower: the plugin serialises, and responses go to every subscribed admin connection (below). Use **one** connection |
| **(b)** Per-agent role (10 commands to create, 2 to delete) | c=1: create p50 7.3 / p99 16.1 ms, 122/s; delete 1.3 ms, 633/s | c=1: create 1.9 / 3.8 ms, 543/s; delete 1.3 ms, 720/s | **GO** as the 2.0 fallback |
| **(b)** Default `set_tcp_nodelay false` | c=1 create p50 **41.1 ms, 24/s** | c=1 create p50 **41.3 ms, 24/s** | Set `set_tcp_nodelay true` |
| **(c)** Churn isolation: 50 agents × 10 msg/s (QoS 1) for 30 s while 200 slots loop create → connect → publish → delete | 0 of 14,964 messages lost, 0 agent disconnects, 0 observer disconnects; 22,048 churn cycles (735/s), 0 errors; no SIGHUP | 0 of 14,983 lost, 0 disconnects; 18,410 cycles (614/s), 0 errors | **GO** |
| **(c)** Kicks while 50 agents connected (all holding role `agent`) | `addRoleACL` new ACL: **50 of 50 kicked**; `removeRoleACL`: **50 of 50**; same ACL again: 0; unrelated role: 0; `addClientRole` / `setClientPassword` on one agent: 1 (that agent); unrelated create+delete: 0 | identical | **GO**, with the rule: never edit a shared role while agents hold it |
| **(d)** 1,000 clients | `dynamic-security.json` 252 KB; RSS 20.3 MB; `listClients` all p50 0.26 ms (17 KB), page of 100 0.06 ms; create at size 4.8 ms; restart to first login 27 ms | 304 KB; RSS 10.0 MB; list all 0.35 ms, page 0.09 ms; create 2.3 ms; restart 127 ms (container start alone: 132 ms) | **GO** |
| **(d)** 10,000 clients | 2.54 MB; RSS 41.2 MB; list all p50 1.35 ms (182 KB), page 0.10 ms; create at size **49.7 ms**, delete 18.3 ms; bulk create in batches of 100: **102 clients/s**; restart to first login 524 ms | 3.08 MB; RSS 22.7 MB; list all 2.64 ms, page 0.09 ms; create 21.2 ms, delete 20.7 ms; bulk 2,009 clients/s; restart 470 ms | **GO** while the sweep keeps the file at live agents plus fixed identities. Every change rewrites the whole file |
| **(e)** `kill -9` mid-churn (10 trials, 10 concurrent creators each) | 0 corrupt files; 0 of 1,229 acknowledged creates missing; 0 login failures among sampled clients; stray `.new` left once | 0 corrupt; 0 of 1,768 missing; 0 login failures; stray `.new` left after every kill (harmless: the next save replaces it) | **GO** (process crash; power loss not measured) |
| **(e)** Write cadence | 30 of 30 changes in the file before the ack; every write replaces the file (new inode: `.new` + rename) | same | **GO** |
| **(f)** `deleteClient` on a connected client | disconnected after p50 2.22 / p99 2.45 ms (20 trials); **no LWT in 20 of 20**; v5 client gets DISCONNECT 0x98 (152, Administrative action) | p50 2.38 / p99 2.91 ms; **no LWT in 20 of 20**; DISCONNECT 152 | **GO**: the daemon publishes `reaped` itself |
| **(f)** `disableClient` on a connected client | disconnected after p50 2.22 / p99 2.56 ms; no LWT in 20 of 20; reconnect refused (CONNACK 5); after `enableClient`: login ok | 2.28 / 2.78 ms; no LWT; refused, then ok | **GO** |
| **(f)** Control: the same client dropping its socket | will delivered in 0.3 ms | 0.3 ms | (the LWT path itself works) |
| **(g)** Per-client expiry / TTL | None. Client object: `username`, `roles`, `groups`; unknown fields (`expiry`, `ttl`) accepted and silently dropped | None (`getClient` adds `connections`) | **GO**, and S5's sweep **is required** |
| **(h)** `per_listener_settings false`, TCP + WebSocket listener | both listeners authenticate through the plugin: dynsec client ok, wrong password and anonymous refused (CONNACK 5); ACL enforced over WebSocket | same | **GO** |
| **(h)** `per_listener_settings true` | plugin repeated under each listener: starts; the two "instances" share one client list | refuses to start: *"Dynamic security plugin can currently only be loaded once"* | Keep `per_listener_settings false` |
| **(i)** Idempotent bootstrap (34 commands, one message) | first run 8 ms, rerun 0.5 ms; ACL count unchanged; 0 connected fixed identities kicked; rerun keeps the original passwords; `addClientRole` rerun says **"Internal error"** | first run 3.8 ms, rerun 0.4 ms; same, including "Internal error" | **GO**, with the error table below |
| **(j)** 2.0.22 vs 2.1.2 | see [Differences](#j-differences-between-2022-and-212) | | |

## Findings in detail

### (a) `%u` and `%c`

The 2.0.22 plugin calls plain `mosquitto_topic_matches_sub` and the 2.0 broker does not export
`mosquitto_topic_matches_sub_with_pattern`, so an ACL topic `volley/+/%u/#` matches only the
literal string `%u`. Upstream's ChangeLog lists the feature under **2.1.0**: *"The dynamic
security plugin now supports `%c` and `%u` patterns for substituting client id and username
respectively, in all ACLs except for subscribeLiteral and unsubscribeLiteral."*

The bench's role shape:

```
role agent:   publishClientSend  volley/+/%u/#               allow
              publishClientSend  volley/_system/registry/%u  allow
              subscribeLiteral   volley/#                    allow
              subscribePattern   volley/#                    allow
role agent-c: publishClientSend  volley/+/%c/#               allow
```

Other observations, on both versions:

- An MQTT 5 publisher learns of a denial from the PUBACK (`Not authorized`, 135). An MQTT 3.1.1
  publisher (Volley agents connect with 3.1.1) gets a normal PUBACK and the message is dropped,
  exactly as with `acl_file` today.
- The `+` caveat in `examples/mosquitto-auth/README.md` carries over unchanged: on 2.1.2,
  `volley/+/%u/#` also lets agent X publish `volley/_waves/X/status`.
- The fallback for 2.0 is a role per agent: `createRole agent-<id>`, its `addRoleACL`s with the
  id written literally, then `createClient` + `addClientRole`, all in one control message. On
  retire: `deleteClient` + `deleteRole`. The same mechanism covers today's `--ack-to <sender>`
  grants (an extra `publishClientSend volley/+/<sender>/mailbox` on the agent's role). On 2.1,
  a shared role per sender (`ack-to-volleyd`) does the same job.

### (b) Latency and serialisation

The plugin runs on the broker's single network thread, so it serialises. Throughput peaks around
c=10..50 on one connection and latency then grows linearly with the queue. Two more effects:

- **Response fan-out.** The plugin publishes every response to
  `$CONTROL/dynamic-security/v1/response`, and every admin connection subscribed there gets it
  (238,700 / 238,800 responses for other connections' commands at c=200). Use one control
  connection and match responses by `correlationData`.
- **Nagle.** With mosquitto's default `set_tcp_nodelay false`, every request/response round
  trip measured about 41 ms on both versions (24 sequential ops/s). Pipelining hides it (a c=50
  run without nodelay still reached about 1,180 ops/s), but a daemon doing one call at a time
  would wait 41 ms per call. `examples/mosquitto-localhost.conf` should set
  `set_tcp_nodelay true`.
- `createClient` with `roles: [{rolename}]` inline (one command) measured p50 0.14 ms (2.0) and
  0.46 ms (2.1) sequentially.

### (c) Churn isolation and kicks

Creating, logging in as, and deleting 18,000-22,000 unrelated clients in 30 s did not disturb
50 publishing agents or the subscriber counting their messages, on either version. No reload
or SIGHUP was involved anywhere.

What *does* disconnect clients is changing a role they hold: `addRoleACL` (a new ACL) or
`removeRoleACL` on role `agent` disconnected all 50 agents, on both versions. Re-adding an
existing ACL is rejected and kicks nobody. A client-level change (`addClientRole`,
`setClientPassword`) disconnects only that client. So S5 must treat the shared roles as
**immutable at runtime**: create them once in `volley auth init`. Changing them later (an
upgrade) is a planned reconnect of every agent. Per-agent roles avoid this, since each one is
edited only while its own agent is being created or retired.

### (d) Scale

Each change rewrites the whole `dynamic-security.json`, so its cost grows with the client
count: a single create costs 0.5 ms at 7 clients, 4.8 ms at 1,000 and 49.7 ms at 10,000 on
2.0.22 (2.1.2: 2.3 ms and 21.2 ms). 2.0.22 also saves once per **command**: a 100-command
message took 360-600 ms at 2,000-10,000 clients. 2.1.2 saves once per **message**
(`dynsec__config_batch_save`): 40-50 ms per 100. Login cost does not depend on the count (about
0.2-0.6 ms at 10,000). `listClients` with `count`/`offset` stays under 0.2 ms; the unpaged
list at 10,000 is a 182 KB response in 1.4-2.6 ms.

A file entry is about 250 B (2.0, `password` + `salt` + `iterations`) or 300 B (2.1,
`encoded_password`). Restarting with 10,000 clients took about 0.5 s to the first accepted
login. Volley's working set (the live agents plus the fixed identities, with the S5 sweep
deleting retired ones) stays far below 1,000, where every number above is a few milliseconds.

### (e) Persistence

The plugin writes `<file>.new` and renames it over the file (a new inode on every change)
before it sends the response: every change of 30 was in the file at the moment its ack arrived.
Ten `kill -9`s in the middle of 10 concurrent creators never left a corrupt or truncated file,
never lost an acknowledged client, and every sampled client created before the kill logged in
after the restart. A stray `dynamic-security.json.new` can remain after a kill (2.1.2 every
time, 2.0.22 once); the next save overwrites it.

Not measured: power loss. Whether the plugin fsyncs before the rename decides whether an
acknowledged change survives a power cut. A `kill -9` does not test that.

### (f) Deleting or disabling a connected client

Both `deleteClient` and `disableClient` disconnect the client before the response arrives
(p50 about 2.2 ms after the request, the same as the ack). An MQTT 5 client sees DISCONNECT
reason 0x98 (Administrative action). **Neither publishes the client's will** (0 of 40 trials
per version), while the same client dropping its socket publishes it in 0.3 ms. The broker
kicks without the will, so the daemon must publish the agent's retained terminal status
(`reaped`) itself after the `deleteClient` response.

A disabled client is refused at login (CONNACK 5 on 3.1.1); `enableClient` restores it.

### (g) Expiry

There is no TTL or expiry of any kind: a client holds `username`, roles, groups and the
password hash. Unknown fields such as `expiry` or `ttl` on `createClient` are accepted and
dropped. The S5 sweep (delete clients whose agent is gone) is required.

### (h) Listeners

The plugin is global. With `per_listener_settings false` (Volley's reference config) the TCP
and the WebSocket listener both authenticate and authorise through it.

With `per_listener_settings true`, authentication options are per listener. Written before
the first `listener` (as the template here writes them), they create an **implicit default
listener on port 1883**. The bench saw 2.0.22 try to bind 1883 and exit because it was taken.
Repeating the plugin under each listener instead starts on 2.0.22 (one shared client list) but
is refused by 2.1.2. Keep `per_listener_settings false`.

### (i) Bootstrap: the sequence `volley auth init` would run

1. If `dynamic-security.json` does not exist:
   `mosquitto_ctrl dynsec init <file> <admin-user> <admin-password>`. **Check for the file
   first**: on an existing file, `init` prints `Unable to open '<file>' for writing (File
   exists).` and still **exits 0** on both versions.
2. Start or restart the broker with `plugin` + `plugin_opt_config_file`.
3. As the admin, send one control message with, per role, `createRole` followed by its
   `addRoleACL`s, then `createClient` + `addClientRole` for `volleyd`, `desk` and
   `coordinator`. These are 34 commands for the role shape of `examples/mosquitto-auth/acl.conf`
   (roles `volley-agent`, `volley-volleyd`, `volley-desk`, `volley-coordinator`). They take 4-8 ms.
4. Rerunning step 3 is safe: no duplicate ACLs, no kicks, original passwords kept. Tolerate
   exactly these errors:

   | Command | Error on rerun (2.0.22 and 2.1.2) |
   |---|---|
   | `createRole` | `Role already exists` |
   | `addRoleACL` | `ACL with this topic already exists` |
   | `createClient` | `Client already exists` (the password is **not** changed; rotation is `setClientPassword`, which kicks that client) |
   | `addClientRole` | `Internal error` (the role was already assigned; check with `getClient` instead of matching this text) |

**Where the admin credential lives.** The plugin itself keeps only salted hashes, and rewrites
its file with mode 0600 (`dynsec init` creates it 0640). The admin password is needed only by
`volley auth` and volleyd. Store it in a 0600 file next to volleyd's config, or in the macOS
Keychain; the bench did not measure either option.

**Linux distribution brokers.** Ubuntu's AppArmor profile for `/usr/sbin/mosquitto` lets the
broker read `/etc/mosquitto` and write only `/var/lib/mosquitto/mosquitto.db{,.new}`. The
plugin cannot write `dynamic-security.json` (or its `.new`) anywhere until a local rule allows
it, for example in `/etc/apparmor.d/local/mosquitto`:

```
/var/lib/mosquitto/dynamic-security.json rw,
/var/lib/mosquitto/dynamic-security.json.new rw,
```

The bench avoids the profile by running a copy of the binary (it attaches by path). The 2.0
plugin also warns about world-readable files and ones not owned by the broker user, and says
future versions will refuse to load them.

### (j) Differences between 2.0.22 and 2.1.2

| | 2.0.22 | 2.1.2 |
|---|---|---|
| `%u` / `%c` in ACLs | no | yes (not in `subscribeLiteral` / `unsubscribeLiteral`) |
| Command set (`mosquitto_ctrl dynsec help`) | as below | same, plus `mosquitto_ctrl -f <file> dynsec setClientPassword` on a file offline |
| Password hash | PBKDF2-SHA512, 101 iterations (`password`, `salt`, `iterations`) | PBKDF2-SHA512, 1,000 iterations, one `encoded_password` (`$7$…`); the plugin also recognises `$argon2id$` hashes |
| File format | pretty-printed JSON | compact JSON |
| Saving | once per command | once per control message |
| Create at 10,000 clients | 49.7 ms | 21.2 ms |
| Plugin loaded twice | allowed | refused |
| `getClient` | `username`, `roles`, `groups` | adds `connections` |
| Rerun errors, kicks, LWT on kick, persistence | identical | identical |
| File compatibility | a 2.0 file loads in 2.1 (admin login ok) | a 2.1 file does **not** load in 2.0 (admin login fails): upgrading is one-way |

The 2.1 numbers come from the Linux container. On the owner's Mac (Homebrew 2.1.x), the same
suite runs natively with `bench/dynsec/run-local.sh` (it finds the Homebrew plugin). That run
would add a native macOS column; behaviour should match the container, timings may not.

## Recommendation for S5

- Use the Dynamic Security plugin: **GO**.
- Pick one of two agent-identity shapes (owner decision):
  - **Per-agent roles** (works on 2.0.22 and 2.1.x): one message with 10 commands per agent,
    7.3 ms on 2.0.22. Also carries the `--ack-to` grants. *Recommended* while Linux hosts run
    the 2.0 distribution package.
  - **Static `%u` role** (2.1.x only): 2 commands per agent. Requires mosquitto ≥ 2.1 everywhere
    and refusing older brokers (`$SYS/broker/version`).
- Use one admin control connection in volleyd, pipelined, matching by `correlationData`.
- Set `set_tcp_nodelay true` and keep `per_listener_settings false` in the reference config.
- On retire: `deleteClient` (plus `deleteRole` for a per-agent role), then publish the
  retained terminal status, because no LWT comes.
- Keep the sweep: nothing expires on its own, and every extra client makes each later change
  slower.
- Never edit the shared roles at runtime; changing them means every client holding them
  reconnects.
- Ship the AppArmor note for Ubuntu hosts.

## How the bench works

```
bench/dynsec/
  bench.ts               the suite: drives $CONTROL/dynamic-security/v1 directly with mqtt.js
  mosquitto-dynsec.conf  broker template (plugin + plugin_opt_config_file, TCP + WS listeners)
  run-local.sh           throwaway broker(s) from the host's mosquitto, then bench.ts
  run-2.1.sh             the same in eclipse-mosquitto:2.1.2-alpine (or macOS steps)
```

```sh
bun install                                   # once: bench.ts uses volley-mcp's mqtt install
bench/dynsec/run-local.sh                     # host mosquitto, about 5 minutes
bench/dynsec/run-2.1.sh                       # 2.1.2 container, about 6 minutes
BENCH_QUICK=1 bench/dynsec/run-local.sh       # smaller sizes, about a minute
BENCH_ONLY=b BENCH_NODELAY=false bench/dynsec/run-local.sh   # one section, Nagle on
```

`run-local.sh` picks random free ports in 20000-39999 (never 1883, 9001 or 18830) and creates
the admin with `mosquitto_ctrl dynsec init`. It starts the broker under test plus a
`per_listener_settings true` broker for row (h), runs `bench.ts`, prints the table and deletes
everything (`BENCH_KEEP=1` keeps the work directory). Full results go to a JSON file
(`BENCH_OUT`). `bench.ts` gets the broker's start/stop/kill/RSS commands from the runner, so
the same suite restarts and `kill -9`s a local process or a container.

Each section is independent and records an error instead of aborting the run, so a broker
that lacks a feature shows up as a measured "no", not a crash. Sections: (i) bootstrap,
(a) ACLs, (h) listeners, (g) expiry, (f) kicks, (b) latency, (c) churn + kicks on role edits,
(d) scale at baseline and 1,000, (e) persistence, (d) scale at 10,000.
