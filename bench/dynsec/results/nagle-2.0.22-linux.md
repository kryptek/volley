# Printed table: nagle-2.0.22-linux

Output of `bench/dynsec/run-local.sh` with `BENCH_ONLY=b BENCH_NODELAY=false`. Full results: [`nagle-2.0.22-linux.json`](nagle-2.0.22-linux.json).


| item | mosquitto version 2.0.22 (Linux, local, set_tcp_nodelay false) |
|---|---|
| (a) %u/%c ACL cases pass | n/a |
| (a) per-agent literal role (control) pass | n/a |
| (b) shared c=1 | create p50 41.04 p95 42.02 p99 42.76 ms, 24.2/s; delete p50 41 p95 41.99 p99 42.03 ms, 24.3/s |
| (b) shared c=10 | create p50 41.13 p95 42.99 p99 43.04 ms, 240.5/s; delete p50 41 p95 41.7 p99 42.04 ms, 243/s |
| (b) shared c=50 | create p50 41.8 p95 42.23 p99 42.29 ms, 1190/s; delete p50 41.83 p95 42.01 p99 42.03 ms, 1190.8/s |
| (b) shared c=200 | create p50 84.78 p95 160.28 p99 179.22 ms, 1471.2/s; delete p50 83.38 p95 126.68 p99 126.75 ms, 2365.8/s |
| (b) per-worker c=1 | create p50 41.03 p95 42 p99 42.01 ms, 24.3/s; delete p50 41.01 p95 41.56 p99 41.98 ms, 24.3/s |
| (b) per-worker c=10 | create p50 41.33 p95 43.04 p99 43.11 ms, 240.2/s; delete p50 41.22 p95 42.22 p99 42.46 ms, 241.6/s |
| (b) per-worker c=50 | create p50 21.25 p95 47.78 p99 62.02 ms, 1466.5/s; delete p50 14.7 p95 46.75 p99 47.73 ms, 1985.5/s |
| (b) per-worker c=200 | create p50 218.36 p95 291.66 p99 295 ms, 777.6/s; delete p50 138.34 p95 197.06 p99 202.36 ms, 1073/s |
| (c) churn: lost / agent disconnects | n/a of n/a / n/a (? churn cycles) |
| (e) kill -9: corrupt / acked-but-missing | n/a / n/a of n/a; visible at ack n/a/ |
| (f) deleteClient -> disconnect | n/a |
| (f) deleteClient -> LWT | n/a (no will: undefined) |
| (f) disableClient -> disconnect | n/a |
| (g) any expiry field | n/a |
| (h) ws anonymous / ws dynsec client | n/a / n/a |
| (i) rerun untolerated errors / kicks | n/a / n/a |
