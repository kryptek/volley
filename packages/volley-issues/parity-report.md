# Volley v0.1 — parity test report

Generated: 2026-10-18

The parity test (design doc §8.5) compares wake latency between the legacy
claude-peers + ScheduleWakeup polling loop and the Volley `volley wait`
notification model. 4 synthetic agents are run through each harness on an
in-process Aedes broker; latency is measured from each agent's terminal
status publish to its coordinator's detection.

## Summary

| harness | median | p95 | max | count |
|---|---|---|---|---|
| legacy | 4.0s | 5.0s | 5.0s | 4 |
| volley | 20ms | 20ms | 20ms | 4 |

**Acceptance:** Volley median < 5s; legacy bounded above by the 270s fallback poll.

## Per-agent

| agent_id | harness | latency |
|---|---|---|
| parity-legacy-01 | legacy | 5.0s |
| parity-legacy-02 | legacy | 4.0s |
| parity-legacy-03 | legacy | 3.0s |
| parity-legacy-04 | legacy | 2.0s |
| parity-volley-01 | volley | 19ms |
| parity-volley-02 | volley | 20ms |
| parity-volley-03 | volley | 19ms |
| parity-volley-04 | volley | 20ms |
