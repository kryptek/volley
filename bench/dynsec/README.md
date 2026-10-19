# Dynamic Security spike: can Volley broker auth run on it?

**Question.** Volley broker auth today edits `password_file` + `acl_file` and SIGHUPs the
broker ([`examples/mosquitto-auth/`](../../examples/mosquitto-auth/README.md)). The plan is to
move it to the mosquitto **Dynamic Security plugin**: agents created and deleted at runtime
over `$CONTROL/dynamic-security/v1`, while 50+ agents stay connected and the daemon creates and
deletes hundreds of agents a day. This spike measures whether that holds on both broker
versions in use, with a number or an observed behaviour per question.

**Answer: GO, for S5's per-agent roles with paced minting.** S5 gives each agent its own role
`agent:<id>`, minted together with the client (row k). The per-agent role exists because
`%u` / `%c` patterns do not work on mosquitto 2.0.x (row a).

- **Publishing does not get slower with more roles.** With 10,000 per-agent roles loaded,
  publish latency and broker CPU per message are the same as with none.
- **Every mint or retire rewrites the whole file and blocks the broker while it does.** The
  stall grows with the number of agents:
  - mosquitto 2.1.2: 16 ms per mint at 1,000 agents, 155 ms at 10,000.
  - mosquitto 2.0.22, which rewrites the file once per **command** (13 per mint): 130 ms per
    mint at 1,000 agents, 1.18 s at 10,000.
- **What that means at Volley's scale:**
  - The daemon mints one at a time and spaced out (S5's scale is hundreds a day).
  - Fine on 2.1.x up to 10,000 agents.
  - Fine on 2.0.x up to about 1,000 agents.
  - Not usable on 2.0.x at 10,000: even one mint per second overloads the broker.
  - The sweep keeps the file at live agents only.
- **Never mint or retire in bursts.** Back-to-back mints at concurrency 10 kept the broker at
  100% CPU on both versions. Connected agents stayed connected, but their messages arrived
  seconds late and overflowed a subscriber's queue.

The other conditions for S5:

- **Delete and disable publish no LWT.** `deleteClient` / `disableClient` disconnect the agent
  without publishing its will, so the daemon publishes the terminal (`reaped`) status itself.
- **Set `set_tcp_nodelay true`.** With mosquitto's default, every sequential control call takes
  41 ms.
- **Never edit a shared role while agents hold it.** An ACL change on a role disconnects every
  client that holds it.
- **Keep `per_listener_settings false`.**

## Go / no-go

Measured on one Linux x86_64 workstation (16 cores, 60 GB RAM, Bun 1.3.14). **2.0.22** is the
distribution package (`mosquitto_dynamic_security.so` from the distro) run as a local process.
**2.1.2** is the official `eclipse-mosquitto:2.1.2-alpine` image, the version Homebrew ships
on macOS, on the host network. Both used `set_tcp_nodelay true`; latency is round-trip from
the Bun client.

Every figure comes from the committed results in [`results/`](results/): the full JSON plus
the table `bench.ts` printed. Sources are
[`2.0.22-linux`](results/2.0.22-linux.md), [`2.1.2-container`](results/2.1.2-container.md),
and the `BENCH_NODELAY=false` runs [`nagle-2.0.22-linux`](results/nagle-2.0.22-linux.md) and
[`nagle-2.1.2-container`](results/nagle-2.1.2-container.md).

"Create" in rows (b) and (d) is `createClient` + `addClientRole` in one message: 2 commands,
so 2 file rewrites on 2.0.22 and 1 on 2.1.2.

| Item | mosquitto 2.0.22 (Linux, distro) | mosquitto 2.1.2 (container) | Verdict |
|---|---|---|---|
| **(a)** Role ACLs with `%u` / `%c` | **Not substituted.** 0 of 4 allow-cases delivered (own status, own registry entry, `%c` topic, `_waves` caveat); the deny-cases were denied. Control case with the id written literally in a per-agent role: delivered. | **Works.** 10 of 10 cases pass: X publishes its own status and registry entry; X → `volley/<ns>/Y/mailbox`, Y's status and Y's registry entry are not delivered; `%c` substitutes the client id, not the username | 2.0: **NO-GO** for a static role, **GO** for per-agent roles. 2.1: **GO** |
| **(b)** Create / delete, one control connection | create c=1 p50 0.47 ms, 1,895/s; c=200 p50 87 ms, 1,336/s. Delete c=1 0.26 ms, 3,479/s ([full matrix](#b-latency-and-serialisation)) | create c=1 0.72 ms, 1,287/s; c=200 130 ms, 1,193/s. Delete c=1 0.34 ms, 2,665/s | **GO**: at least 1,190 creates/s, against a need of hundreds per day |
| **(b)** One control connection per worker | c=200: create p50 301 ms, 541/s | c=200: create p50 342 ms, 525/s | Slower from c=50: the plugin serialises, and responses go to every subscribed admin connection. Use **one** connection |
| **(b)** Default `set_tcp_nodelay false` | c=1 create p50 **41.0 ms, 24/s** | c=1 create p50 **42.0 ms, 24/s** | Set `set_tcp_nodelay true` |
| **(c)** Churn isolation: 50 agents × 10 msg/s (QoS 1) for 30 s while 200 slots loop create → connect → publish → delete | 0 of 14,950 messages lost, 0 agent disconnects, 0 observer disconnects; 21,788 churn cycles (726/s), 0 errors; no SIGHUP | 0 of 15,000 lost, 0 disconnects; 18,452 cycles (615/s), 0 errors | **GO** |
| **(c)** Kicks while 50 agents connected (all holding role `agent`) | `addRoleACL` new ACL: **50 of 50 kicked**; `removeRoleACL`: **50 of 50**; same ACL again: 0; unrelated role: 0; `addClientRole` / `setClientPassword` on one agent: 1 (that agent); unrelated create+delete: 0 | identical | **GO**, with the rule: never edit a shared role while agents hold it |
| **(d)** 1,000 clients (shared role) | file 252 KB; RSS 20.3 MB; `listClients` all p50 0.20 ms (17 KB), page of 100 0.07 ms; create at size 3.0 ms; restart to first login 30 ms | 305 KB; RSS 10.1 MB; list all 0.35 ms, page 0.06 ms; create 2.2 ms; restart 129 ms (container start alone: 125 ms) | **GO** |
| **(d)** 10,000 clients (shared role) | 2.49 MB; RSS 40.5 MB; list all p50 1.62 ms (181 KB), page 0.11 ms; create at size **32.2 ms**, delete 16.2 ms; bulk create in batches of 100: **104 clients/s** (381 ms per batch at about 2,500 clients, 1,151 ms at 10,000); restart to first login 522 ms | 3.00 MB; RSS 22.4 MB; list all 2.58 ms, page 0.08 ms; create 20.2 ms, delete 19.8 ms; bulk 2,033 clients/s (29–41 ms per batch); restart 448 ms | **GO** while the sweep keeps the file at live agents plus fixed identities. Every change rewrites the whole file |
| **(e)** `kill -9` mid-churn (10 trials, 10 concurrent creators each) | 0 corrupt files; 0 of 1,492 acknowledged creates missing; 0 login failures among sampled clients; stray `.new` left in 2 of 10 | 0 corrupt; 0 of 2,219 missing; 0 login failures; stray `.new` left in 9 of 10 (harmless: the next save replaces it) | **GO** (process crash; power loss not measured) |
| **(e)** Write cadence | 30 of 30 changes in the file before the ack; every write replaces the file (new inode: `.new` + rename) | same | **GO** |
| **(f)** `deleteClient` on a connected client | socket closed p50 2.29 / p99 3.03 ms after the request, about when the ack arrives (ack p50 2.27 ms); **no LWT in 20 of 20**; v5 client gets DISCONNECT 0x98 (152, Administrative action) | close p50 2.31 / p99 2.66 ms (ack 2.14 ms); **no LWT in 20 of 20**; DISCONNECT 152 | **GO**: the daemon publishes `reaped` itself |
| **(f)** `disableClient` on a connected client | close p50 2.32 / p99 2.99 ms; no LWT in 20 of 20; reconnect refused (CONNACK 5); after `enableClient`: login ok | 2.24 / 2.49 ms; no LWT; refused, then ok | **GO** |
| **(f)** Control: the same client dropping its socket | will delivered in 0.22–0.28 ms | 0.16–0.44 ms | (the LWT path itself works) |
| **(g)** Per-client expiry / TTL | None. Client object: `username`, `roles`, `groups`; unknown fields (`expiry`, `ttl`) accepted and silently dropped | None (`getClient` adds `connections`) | **GO**, and S5's sweep **is required** |
| **(h)** `per_listener_settings false`, TCP + WebSocket listener | both listeners authenticate through the plugin: dynsec client ok, wrong password and anonymous refused (CONNACK 5); ACL enforced over WebSocket | same | **GO** |
| **(h)** `per_listener_settings true` | plugin repeated under each listener: starts; the two "instances" share one client list | refuses to start: *"Dynamic security plugin can currently only be loaded once"* | Keep `per_listener_settings false` |
| **(i)** Idempotent bootstrap (36 commands, one message) | first run 6.2 ms, rerun 0.5 ms; 0 untolerated errors; ACL count unchanged; 0 connected fixed identities kicked; rerun keeps the original passwords | first run 4.2 ms, rerun 0.4 ms; same | **GO**, with the error table below |
| **(j)** 2.0.22 vs 2.1.2 | see [Differences](#j-differences-between-2022-and-212) | | **GO** on both; the 2.0 → 2.1 upgrade is one-way |
| **(k)** Per-agent role: mint / retire p50 (p99), one at a time | 100 agents: 19.4 (21.7) / 3.1 (5.5) ms · 1,000: 130 (139) / 20.1 (21.4) ms · 10,000: **1,184 (1,201) / 182 (187) ms** | 100: 2.7 (3.7) / 2.3 (2.6) ms · 1,000: 16.2 (17.1) / 15.8 (16.2) ms · 10,000: 155 (162) / 155 (161) ms | Cost grows with the agent count; [scaling verdict](#k-per-agent-roles-at-scale) |
| **(k)** Mint pairs/s at concurrency 1 / 10 / 50, one connection (100 agents) | 31.6 / 35.2 / 34.9 pairs/s (mint p50 31 / 276 / 1,257 ms) | 221 / 244 / 243 pairs/s (p50 4.5 / 40 / 188 ms) | Serialised: concurrency adds only queueing. **GO**, mint one at a time |
| **(k)** File size / RSS: per-agent vs client-only | 1,000: 1.88 MB / 24.5 MB vs 0.34 MB / 20.5 MB · 10,000: **18.1 MB / 120 MB** vs 2.59 MB / 41.6 MB | 1,000: 1.89 MB / 13.7 MB vs 0.32 MB / 10.2 MB · 10,000: 18.2 MB / 58.2 MB vs 2.39 MB / 22.4 MB | 5.5–7.6× the client-only file (1.8 KB per agent). **GO** |
| **(k)** Publish path: 50 agents × 10 msg/s, 20 s; flood of 10,000 QoS 1 | 0 roles / 1,000 / 10,000: p50 0.92 / 0.92 / 0.95 ms, p99 1.43 / 1.36 / 1.44 ms; CPU 1.5–1.6%; flood 93.5–95k msg/s at 0.08–0.09 CPU-s per 10k | p50 0.92–0.93 ms, p99 1.39–1.48 ms; CPU 1.4–1.5%; flood 130–134k msg/s at 0.06 CPU-s per 10k | **GO**: ACL checks do not slow down with 10,000 roles |
| **(k)** Load / restart with 10,000 per-agent roles | file written offline, start to agent login 143 ms; graceful restart: stop 135 ms, start to login 152 ms; RSS after restart 132 MB | 306 ms; stop 123 ms, start to login 358 ms (container start alone: 125 ms); RSS 57.5 MB | **GO** |
| **(k)** 50 agents publishing while other agents are minted and retired | paced, 1 pair/s for 20 s: 1,000 agents: 0 lost, 0 disconnects, publish p99 138 ms (max 154). 10,000: 0 disconnects but **12,192 of 13,500 lost**, p50 26 s (a mint takes longer than 1 s). Back-to-back at c=10: 0 disconnects; 1,000 agents: 796 pairs, 86,282 of 89,100 lost; 10,000: 87 pairs, 57,028 of 59,250 lost | paced: 1,000: 0 lost, p99 19.6 ms (max 35); 10,000: 0 lost, 0 disconnects, p99 298 ms (max 323). Back-to-back at c=10: 1,000 agents: 1,000 pairs, 9,588 of 24,078 lost; 10,000: 386 pairs, 54,080 of 60,500 lost | 0 disconnects everywhere. **GO** paced on 2.1 to 10,000 and on 2.0 to 1,000; **NO-GO** on 2.0 at 10,000, and for burst minting anywhere |

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
  `volley/+/%u/#` also lets agent X publish `volley/_waves/X/status`. Per-agent roles have the
  same `+` in their topics.
- The per-agent role that works on both versions is measured at scale in [(k)](#k-per-agent-roles-at-scale).

### (b) Latency and serialisation

One control connection, create (`createClient` + `addClientRole`) and delete, p50 / p95 / p99
in ms and ops/s:

| Concurrency | 2.0.22 create | 2.0.22 delete | 2.1.2 create | 2.1.2 delete |
|---|---|---|---|---|
| 1 | 0.47 / 0.74 / 2.20, 1,895/s | 0.26 / 0.42 / 2.02, 3,479/s | 0.72 / 0.92 / 2.50, 1,287/s | 0.34 / 0.52 / 2.16, 2,665/s |
| 10 | 4.13 / 6.77 / 7.28, 2,351/s | 2.10 / 3.67 / 4.70, 4,651/s | 6.16 / 9.32 / 10.13, 1,543/s | 2.85 / 6.04 / 6.59, 3,355/s |
| 50 | 18.71 / 30.63 / 31.58, 2,301/s | 10.33 / 15.41 / 16.05, 4,735/s | 28.89 / 42.69 / 46.63, 1,584/s | 13.83 / 22.26 / 22.30, 3,511/s |
| 200 | 87.29 / 198.63 / 208.92, 1,336/s | 66.90 / 99.33 / 101.79, 2,746/s | 129.76 / 198.01 / 209.97, 1,193/s | 86.06 / 124.38 / 138.13, 2,129/s |

One control connection **per worker**, and the responses each connection received for other
connections' commands:

| Concurrency | 2.0.22 create | 2.0.22 delete | 2.1.2 create | 2.1.2 delete | Foreign responses (2.0 / 2.1) |
|---|---|---|---|---|---|
| 1 | 0.50 / 0.73 / 2.35, 1,843/s | 0.23 / 0.38 / 1.94, 3,720/s | 0.72 / 2.04 / 2.54, 1,275/s | 0.34 / 0.52 / 1.93, 2,662/s | 0 / 0 |
| 10 | 4.68 / 10.02 / 11.14, 2,014/s | 2.53 / 4.71 / 6.14, 3,766/s | 6.35 / 12.89 / 15.38, 1,400/s | 3.21 / 6.21 / 8.80, 2,882/s | 5,395 / 5,399 |
| 50 | 30.45 / 53.16 / 58.46, 1,434/s | 21.12 / 27.08 / 31.63, 2,150/s | 38.50 / 76.50 / 91.99, 1,092/s | 24.16 / 34.36 / 43.39, 1,814/s | 29,400 / 29,367 |
| 200 | 301.19 / 438.02 / 439.28, 541/s | 252.08 / 296.48 / 313.54, 701/s | 341.72 / 419.57 / 420.98, 525/s | 256.23 / 319.36 / 335.44, 671/s | 238,461 / 238,411 |

- **The plugin serialises.** It runs on the broker's single network thread, so throughput
  peaks around c=10..50 and latency then grows with the queue.
- **Response fan-out.** Every response goes to `$CONTROL/dynamic-security/v1/response`, so
  every subscribed admin connection gets it. Per-worker connections match a single connection
  up to c=10 and fall behind from c=50, as the foreign responses grow. Use one control
  connection and match responses by `correlationData`.
- **Nagle.** With mosquitto's default `set_tcp_nodelay false`, every request/response round
  trip measured 41.0 ms (2.0.22) and 42.0 ms (2.1.2) at c=1: 24 sequential ops/s. Pipelining
  hides it (c=50 still reached 1,190 / 1,183 ops/s), but a daemon doing one call at a time
  would wait 41 ms per call. `examples/mosquitto-localhost.conf` should set
  `set_tcp_nodelay true`.
- `createClient` with `roles: [{rolename}]` inline (one command) measured p50 0.13 ms (2.0) and
  0.47 ms (2.1) sequentially.

### (c) Churn isolation and kicks

Creating, logging in as, and deleting 18,000-22,000 unrelated clients in 30 s did not disturb
50 publishing agents or the subscriber counting their messages, on either version. No reload
or SIGHUP was involved anywhere.

What *does* disconnect clients is changing a role they hold: `addRoleACL` (a new ACL) or
`removeRoleACL` on role `agent` disconnected all 50 agents, on both versions. Re-adding an
existing ACL is rejected and kicks nobody. A client-level change (`addClientRole`,
`setClientPassword`) disconnects only that client. So S5 must treat shared roles (the fixed
identities' roles, and `volley-agent` on 2.1) as **immutable at runtime**: create them once in
`volley auth init`. Changing one later is a planned reconnect of every client that holds it.
A per-agent role is only ever edited while its own agent is minted or retired.

### (d) Scale

Each change rewrites the whole `dynamic-security.json`, so its cost grows with the client
count:

- A 2-command create costs 0.47 ms in a near-empty file (row b), 3.0 ms at 1,000 and 32.2 ms at 10,000 on
  2.0.22 (2.1.2: 0.72, 2.2 and 20.2 ms).
- 2.0.22 also saves once per **command**. A 100-command message took 381 ms at about 2,500
  clients and 1,151 ms at 10,000 (104 clients/s overall).
- 2.1.2 saves once per **message** (`dynsec__config_batch_save`): 29–41 ms per 100
  (2,033 clients/s).
- Login cost does not depend on the count: p50 0.26 ms (2.0) and 0.51 ms (2.1) at 10,000.
- `listClients` with `count`/`offset` stays under 0.2 ms; the unpaged list at 10,000 is a
  181 KB response in 1.6–2.6 ms.

A file entry is about 250 B (2.0, `password` + `salt` + `iterations`) or 300 B (2.1,
`encoded_password`) for a client with a shared role. A per-agent role adds about 1.6 KB
(row k). Restarting with 10,000 clients took about 0.5 s to the first accepted login.

### (e) Persistence

The plugin writes `<file>.new` and renames it over the file (a new inode on every change)
before it sends the response: every change of 30 was in the file at the moment its ack arrived.
Ten `kill -9`s in the middle of 10 concurrent creators never left a corrupt or truncated file.
No acknowledged client was lost, counting acks read after the kill. Every sampled client created
before the kill logged in after the restart. A stray `dynamic-security.json.new` can remain after a kill
(2.1.2 in 9 of 10 trials, 2.0.22 in 2 of 10); the next save overwrites it.

Not measured: power loss. Whether the plugin fsyncs before the rename decides whether an
acknowledged change survives a power cut. A `kill -9` does not test that.

### (f) Deleting or disabling a connected client

Both `deleteClient` and `disableClient` close the client's socket within about the same 2 ms as
the response. Client-side, the close was seen *before* the ack in 1 and 2 of 20 trials on
2.0.22 and in 0 of 20 on 2.1.2. The two events arrive on different sockets, so this does not
order them inside the broker. An MQTT 5 client sees DISCONNECT reason 0x98 (Administrative
action).

**Neither publishes the client's will** (0 of 20 trials per command and version), while the
same client dropping its socket publishes it in under 0.5 ms. The daemon must therefore publish
the agent's retained terminal status (`reaped`) itself. It should not assume the kick has
already happened when the `deleteClient` response arrives: if S5 needs that ordering, it has to
come from the plugin source, not from this measurement. A deleted client can no longer publish
once its socket is closed, so a `reaped` published after the close stays.

A disabled client is refused at login (CONNACK 5 on 3.1.1); `enableClient` restores it.

### (g) Expiry

There is no TTL or expiry of any kind: a client holds `username`, roles, groups and the
password hash. Unknown fields such as `expiry` or `ttl` on `createClient` are accepted and
dropped. The S5 sweep (delete clients whose agent is gone) is required.

### (h) Listeners

The plugin is global. With `per_listener_settings false` (Volley's reference config) the TCP
and the WebSocket listener both authenticate and authorise through it.

With `per_listener_settings true`, authentication options are per listener. Written before
the first `listener` (where `mosquitto-dynsec.conf` writes them), they create an **implicit
default listener on port 1883**: during development 2.0.22 tried to bind 1883 and exited
because it was taken. The template therefore hard-codes `false`. Repeating the plugin under
each listener instead starts on 2.0.22 (one shared client list) but is refused by 2.1.2. Keep
`per_listener_settings false`.

### (i) Bootstrap: the sequence `volley auth init` would run

1. If `dynamic-security.json` does not exist:
   `mosquitto_ctrl dynsec init <file> <admin-user> <admin-password>`. **Check for the file
   first**: on an existing file, `init` prints `Unable to open '<file>' for writing (File
   exists).` and still **exits 0** on both versions.
2. Start or restart the broker with `plugin` + `plugin_opt_config_file`.
3. As the admin, send one control message: per role, `createRole` followed by its
   `addRoleACL`s; then `createClient` + `addClientRole` for `volleyd`, `desk` and
   `coordinator`. The bench sends the role shape of `examples/mosquitto-auth/acl.conf`: roles
   `volley-agent`, `volley-volleyd`, `volley-desk`, `volley-coordinator`. `desk` and
   `coordinator` also get `volley-agent`, because `acl.conf`'s `pattern` lines apply to every
   user. That is 36 commands, 4–6 ms.
   - `volley-agent` is the **2.1 shape** (`%u`). With per-agent roles, `volley auth init`
     creates only the fixed identities and their roles. The fixed identities' own-channel
     grants are then written literally (e.g. `volley/+/desk/status`), and each agent's role
     comes from the mint at spawn (row k).
4. Rerunning step 3 is safe: no duplicate ACLs, no kicks, original passwords kept, 0 errors
   outside this table:

   | Command | Error on rerun (2.0.22 and 2.1.2) |
   |---|---|
   | `createRole` | `Role already exists` |
   | `addRoleACL` | `ACL with this topic already exists` |
   | `createClient` | `Client already exists` (the password is **not** changed; rotation is `setClientPassword`, which kicks that client) |
   | `addClientRole` | `Internal error`. The role was already assigned: the bench checks with `getClient` (`coordinator` holds `volley-agent` + `volley-coordinator` after the rerun), and S5 should too, instead of matching this text |

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
| Command set (`mosquitto_ctrl dynsec help`) | identical | identical, plus `mosquitto_ctrl -f <file> dynsec setClientPassword` (set a password in the file offline) |
| Password hash | PBKDF2-SHA512, 101 iterations (`password`, `salt`, `iterations`) | PBKDF2-SHA512, 1,000 iterations, one `encoded_password` (`$7$…`); the plugin also recognises `$argon2id$` hashes |
| File format | pretty-printed JSON | compact JSON |
| Saving | once per command | once per control message |
| 2-command create at 10,000 clients | 32.2 ms (2 file writes) | 20.2 ms (1 write) |
| Per-agent mint (13 commands) at 10,000 agents | 1,184 ms (13 writes) | 155 ms (1 write) |
| Plugin loaded twice | allowed | refused |
| `getClient` | `username`, `roles`, `groups` | adds `connections` |
| Rerun errors, kicks, LWT on kick, persistence | identical | identical |
| File compatibility | a 2.0 file loads in 2.1 (admin login ok) | 2.0 starts on a 2.1 file but **refuses every login** (`not authorised`: it ignores `encoded_password`), the admin included. Upgrading is one-way |

The 2.1 numbers come from the Linux container. On the owner's Mac (Homebrew 2.1.x), the same
suite runs natively with `bench/dynsec/run-local.sh` (it finds the Homebrew plugin). That run
would add a native macOS column; behaviour should match the container, timings may not.

### (k) Per-agent roles at scale

S5's identity shape: each agent `<id>` gets a role `agent:<id>` with 11 ACLs. They are its
own `status`, `progress`, `result`, `capability`, `control` and `_user/#`; its registry entry;
lease requests; acks to its parent's and the daemon's mailbox; and `subscribePattern volley/#`.
`createClient <id>` names that role inline.

- **Mint:** one control message of 13 commands.
- **Retire:** `deleteClient` + `deleteRole`.
- **Populations:** 100, 1,000 and 10,000 agents were written into the stopped broker's file
  (minting 10,000 over the API takes hours on 2.0), then loaded, which also measures the load
  time. Each population is checked by logging in as one of its agents.
- **Live measurements:** mint/retire latency, concurrency, the publish path and churn were then
  measured over the API, with 50 publishing agents connected.

**The publish path does not depend on the role count.** Each client's ACL check looks only at
its own roles:

- 50 agents at 10 msg/s: p99 1.43 / 1.36 / 1.44 ms with 0 / 1,000 / 10,000 per-agent roles on
  2.0.22 (1.45 / 1.39 / 1.48 ms on 2.1.2).
- Broker CPU stayed at 1.4–1.6%.
- A flood of 10,000 QoS 1 messages was PUBACKed at 93–95k msg/s (2.0) and 130–134k msg/s (2.1),
  at 0.06–0.09 CPU-s per 10,000 messages, unchanged by the role count.

**Mint and retire cost grows with the file, and blocks the broker while it runs.** Per-agent
roles make the file 5.5–7.6 times larger than client-only entries: 1.8 KB per agent (18.1 MB
at 10,000 agents, against 2.6 MB for clients that share a role). On 2.0.22 a mint is 13 file
rewrites, so:

| Agents | 2.0.22 mint / retire p50 | 2.1.2 mint / retire p50 | Pairs/s one broker can sustain (1000 ÷ (mint + retire)) |
|---|---|---|---|
| 100 | 19.4 / 3.1 ms | 2.7 / 2.3 ms | about 44 (2.0) / 200 (2.1) |
| 1,000 | 130 / 20.1 ms | 16.2 / 15.8 ms | about 6.7 / 31 |
| 10,000 | 1,184 / 182 ms | 155 / 155 ms | about 0.7 / 3.2 |

While a mint or retire runs, the broker serves nobody, so the stall shows up directly in
publish latency:

- **Minted one pair per second** (the pace of a supervisor dispatching agents) while 50
  agents published:
  - 1,000 agents: 0 lost and 0 disconnects on both versions. Publish p99 138 ms on 2.0.22
    (max 154), 19.6 ms on 2.1.2 (max 35).
  - 10,000 agents on 2.1.2: 0 lost, 0 disconnects, p99 298 ms (max 323).
  - 10,000 agents on 2.0.22: a mint plus retire takes 1.4 s, longer than the 1 s period, so the
    broker never caught up. Messages were 26 s late, and 12,192 of 13,500 were dropped by the
    subscriber's queue (mosquitto's `max_queued_messages`, default 1,000).
- **Minted back-to-back at concurrency 10:** 0 disconnects on both versions, but the broker
  sat at 100% CPU and the publishers' messages arrived seconds to minutes late, mostly dropped
  from the subscriber's queue:
  - 2.1.2, 1,000 agents: 1,000 pairs at 40.8 pairs/s, 9,588 of 24,078 lost.
  - 2.0.22, 1,000 agents: 796 pairs at 5.0 pairs/s, 86,282 of 89,100 lost.
  - At 10,000 agents: 2.0.22 87 pairs (96% lost), 2.1.2 386 pairs (89% lost).

  A Desk subscriber would lose the same messages.

**Scaling verdict.**

- **Mint one agent at a time, paced**, and keep the population at the live agents with the
  sweep.
- **2.1.x: GO up to 10,000 agents.** The worst stall per mint was 155 ms at 10,000 agents, and
  16 ms at 1,000.
- **2.0.x: GO up to about 1,000 agents** (a 130 ms stall per mint), **NO-GO at 10,000**
  (1.2 s per mint).
- **Never mint in bursts on either version.** Volleyd should serialise mint and retire on its
  one control connection and rate-limit them. At hundreds of agents a day and a live set far
  below 1,000, both versions have more than 10 times the headroom needed.

Restarting with 10,000 per-agent roles is fast: 152 ms (2.0.22) and 358 ms (2.1.2) from start
to the first login. RSS rises to 120–132 MB on 2.0.22 and 58 MB on 2.1.2. Loading 10,000
**client-only** entries took longer than loading 10,000 per-agent ones: 480 ms against 143 ms
(2.0.22), and 471 ms against 306 ms (2.1.2). Every one of those clients names the same role,
and attaching clients to a shared role is slower than to one role each.

## Recommendation for S5

- Use the Dynamic Security plugin with **per-agent roles**: **GO** (row k). They work on 2.0.22
  and 2.1.x and also carry the ack grants. On 2.1.x, a static `%u` role would be the cheaper
  alternative (2 commands per agent, row a).
- In volleyd, use one admin control connection matching by `correlationData`. **Serialise and
  pace** mint/retire; never burst. Prefer mosquitto ≥ 2.1, where a mint is one file write
  instead of 13.
- Set `set_tcp_nodelay true` and keep `per_listener_settings false` in the reference config.
- On retire: `deleteClient` + `deleteRole`, then publish the retained terminal status, because
  no LWT comes.
- Keep the sweep: nothing expires on its own, and every extra agent makes each later mint
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
  results/               the committed runs every figure above comes from
```

```sh
bun install                                   # once: bench.ts uses volley-mcp's mqtt install
bench/dynsec/run-local.sh                     # host mosquitto, about 15 minutes on 2.0.22
bench/dynsec/run-2.1.sh                       # 2.1.2 container, about 10 minutes
BENCH_QUICK=1 bench/dynsec/run-local.sh       # smaller sizes, about 4 minutes
BENCH_ONLY=b BENCH_NODELAY=false bench/dynsec/run-local.sh   # one section, Nagle on
```

`run-local.sh` picks random free ports in 20000-39999 (never 1883, 9001 or 18830) and creates
the admin with `mosquitto_ctrl dynsec init`. It starts the broker under test plus a
`per_listener_settings true` broker for row (h), runs `bench.ts`, prints the table and deletes
everything (`BENCH_KEEP=1` keeps the work directory). Full results go to a JSON file in
`BENCH_OUT`, with machine-local paths replaced by `<work>` / `<repo>`. `bench.ts` gets the
broker's start/stop/kill/RSS/CPU commands from the runner, so the same suite restarts and
`kill -9`s a local process or a container.

Each section is independent and records an error instead of aborting the run, so a broker
that lacks a feature shows up as a measured "no", not a crash. Sections: (i) bootstrap,
(a) ACLs, (h) listeners, (g) expiry, (f) kicks, (b) latency, (c) churn + kicks on role edits,
(d) scale at baseline and 1,000, (e) persistence, (d) scale at 10,000, (k) per-agent roles.
