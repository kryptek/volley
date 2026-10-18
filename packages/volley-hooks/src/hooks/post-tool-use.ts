#!/usr/bin/env bun
/**
 * PostToolUse (matcher "" = every tool): publish `resumed` if the agent was idle or waiting,
 * drain the mailbox into `additionalContext` (acking each message), heartbeat.
 * `VOLLEY_HOOKS_DRAIN_MATCHER` narrows which tools drain.
 */
import { drainHook } from "../lib/drain";
import { runHook } from "../lib/hook-io";

export const handle = drainHook;

if (import.meta.main) await runHook("PostToolUse", handle);
