#!/usr/bin/env bun
/** UserPromptSubmit: `resumed` if needed, mailbox drain + inject + ack, heartbeat. */
import { drainHook } from "../lib/drain";
import { runHook } from "../lib/hook-io";

export const handle = drainHook;

if (import.meta.main) await runHook("UserPromptSubmit", handle);
