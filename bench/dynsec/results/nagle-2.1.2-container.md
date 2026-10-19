# Printed table: nagle-2.1.2-container

Output of `bench/dynsec/run-2.1.sh` with `BENCH_ONLY=b BENCH_NODELAY=false`. Full results: [`nagle-2.1.2-container.json`](nagle-2.1.2-container.json).

    run-2.1.sh: 2.0 file in 2.1: broker starts, admin login ok
    run-2.1.sh: 2.1 file in 2.0: broker starts, admin login REFUSED (Client auto-1ABEEA25-9134-F884-FD78-06999A77BB9C disconnected, not authorised.)

| item | mosquitto version 2.1.2 (container eclipse-mosquitto:2.1.2-alpine, set_tcp_nodelay false) |
|---|---|
| (a) %u/%c ACL cases pass | n/a |
| (a) per-agent literal role (control) pass | n/a |
| (b) shared c=1 | create p50 41.97 p95 42.05 p99 43.02 ms, 23.9/s; delete p50 41.01 p95 41.99 p99 42.04 ms, 24.3/s |
| (b) shared c=10 | create p50 41.88 p95 42.17 p99 42.96 ms, 238.5/s; delete p50 40.95 p95 41.13 p99 41.98 ms, 243.6/s |
| (b) shared c=50 | create p50 41.84 p95 42.63 p99 42.7 ms, 1183.1/s; delete p50 41.71 p95 42.12 p99 42.16 ms, 1196.6/s |
| (b) shared c=200 | create p50 126.82 p95 183.67 p99 187.68 ms, 1266.2/s; delete p50 84.04 p95 126.29 p99 167.96 ms, 1908.1/s |
| (b) per-worker c=1 | create p50 41.96 p95 42.05 p99 42.97 ms, 24/s; delete p50 41 p95 41.96 p99 42.02 ms, 24.3/s |
| (b) per-worker c=10 | create p50 41.92 p95 43.39 p99 43.87 ms, 238.3/s; delete p50 41.12 p95 42.36 p99 42.62 ms, 241.8/s |
| (b) per-worker c=50 | create p50 31.52 p95 76.28 p99 92.23 ms, 1082.5/s; delete p50 16.82 p95 33.7 p99 37.31 ms, 2729.1/s |
| (b) per-worker c=200 | create p50 261.82 p95 295.03 p99 307.91 ms, 696.2/s; delete p50 139.44 p95 223.82 p99 228.25 ms, 1090.8/s |
| (c) churn: lost / agent disconnects | n/a of n/a / n/a (? churn cycles) |
| (e) kill -9: corrupt / acked-but-missing | n/a / n/a of n/a; visible at ack n/a/ |
| (f) deleteClient -> disconnect | n/a |
| (f) deleteClient -> LWT | n/a (no will: undefined) |
| (f) disableClient -> disconnect | n/a |
| (g) any expiry field | n/a |
| (h) ws anonymous / ws dynsec client | n/a / n/a |
| (i) rerun untolerated errors / kicks | n/a / n/a |
