import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { writeFileAtomic } from "./seq";

/**
 * `.volley/STEERING.md` — every mailbox directive this agent has received, so steering
 * survives compaction and restarts. One block per message:
 *
 *     ## <seq|-> <type> <message id>
 *     <!-- volley from=<sender> at=<iso> state=live|superseded|done [by=<id>] -->
 *     <text>
 *
 * `state=done` is never written by the hooks; an agent or operator may set it by hand to
 * stop a directive being re-injected after a compaction.
 */

export type BlockState = "live" | "superseded" | "done";

export interface SteeringBlock {
  seq: number | null;
  type: string;
  id: string;
  from: string;
  at: string;
  state: BlockState;
  supersededBy?: string;
  text: string;
}

export type NewBlock = Omit<SteeringBlock, "state" | "supersededBy">;

const HEADER = "# Volley steering\n";
const BLOCK_HEAD = /^## (\S+) (\S+) (\S+)$/;
const META = /^<!-- volley (.*) -->$/;

/** Text lines that would parse as a block heading are escaped with a leading space. */
const escapeText = (text: string) => text.replace(/^## /gm, " ## ");
const unescapeText = (text: string) => text.replace(/^ ## /gm, "## ");

function render(b: SteeringBlock): string {
  const meta = [`from=${b.from}`, `at=${b.at}`, `state=${b.state}`];
  if (b.supersededBy !== undefined) meta.push(`by=${b.supersededBy}`);
  return `## ${b.seq ?? "-"} ${b.type} ${b.id}\n<!-- volley ${meta.join(" ")} -->\n${escapeText(b.text)}\n`;
}

export function readBlocks(path: string): SteeringBlock[] {
  if (!existsSync(path)) return [];
  const blocks: SteeringBlock[] = [];
  let current: { block: SteeringBlock; lines: string[]; meta: boolean } | null = null;
  const flush = () => {
    if (current === null) return;
    current.block.text = unescapeText(current.lines.join("\n").replace(/^\n+|\n+$/g, ""));
    blocks.push(current.block);
  };
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    const head = BLOCK_HEAD.exec(line);
    if (head !== null) {
      flush();
      const [, seq, type, id] = head as unknown as [string, string, string, string];
      const n = Number(seq);
      current = {
        block: {
          seq: Number.isSafeInteger(n) ? n : null,
          type,
          id,
          from: "",
          at: "",
          state: "live",
          text: "",
        },
        lines: [],
        meta: false,
      };
      continue;
    }
    if (current === null) continue;
    const meta = !current.meta && current.lines.length === 0 ? META.exec(line) : null;
    if (meta !== null) {
      for (const pair of (meta[1] ?? "").split(" ")) {
        const [k, v = ""] = pair.split("=", 2);
        if (k === "from") current.block.from = v;
        else if (k === "at") current.block.at = v;
        else if (k === "by") current.block.supersededBy = v;
        else if (k === "state" && (v === "live" || v === "superseded" || v === "done")) {
          current.block.state = v;
        }
      }
      current.meta = true;
      continue;
    }
    current.lines.push(line);
  }
  flush();
  return blocks;
}

function writeBlocks(path: string, blocks: SteeringBlock[]): void {
  writeFileAtomic(path, `${HEADER}\n${blocks.map(render).join("\n")}`);
}

export function hasBlock(path: string, id: string): boolean {
  return readBlocks(path).some((b) => b.id === id);
}

export function appendBlock(path: string, block: NewBlock): void {
  const text = render({ ...block, state: "live" });
  if (!existsSync(path)) {
    writeFileAtomic(path, `${HEADER}\n${text}`);
    return;
  }
  writeFileSync(path, `\n${text}`, { flag: "a" });
}

/**
 * Mark the live block `id` superseded by `by`. SPEC §4.4: only the block's own sender may
 * supersede it. Returns whether a block changed.
 */
export function markSuperseded(path: string, id: string, by: string, from: string): boolean {
  const blocks = readBlocks(path);
  const target = blocks.find((b) => b.id === id && b.state === "live" && b.from === from);
  if (target === undefined) return false;
  target.state = "superseded";
  target.supersededBy = by;
  writeBlocks(path, blocks);
  return true;
}

/** Directives still in force: neither superseded nor done. */
export function liveDirectives(path: string): SteeringBlock[] {
  return readBlocks(path).filter((b) => b.state === "live");
}
