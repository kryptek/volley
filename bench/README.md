# Benchmarks and spikes

Measurements that back design decisions. Nothing here is product code: no package imports it,
and `bun run test` does not run it. Each directory has its own README with the findings,
the exact command that produced them, and how to rerun it.

| Directory | Question | Run |
|---|---|---|
| [`dynsec/`](dynsec/README.md) | Can broker auth move to the mosquitto Dynamic Security plugin (per-agent clients created and deleted at runtime)? Go/no-go per item, on mosquitto 2.0.22 and 2.1.2. | `bench/dynsec/run-local.sh`, `bench/dynsec/run-2.1.sh` |

Benchmarks start their own throwaway brokers on random free ports. They never use the ports a
real Volley broker listens on (1883, 9001).
