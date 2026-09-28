import fs from "fs";
import { parse } from "jsonc-parser";
import { JEV_DEBUG_LOG, OPENCODE_JSONC } from "./shared.js";

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

export function getLocalTimestamp(): string {
  const d = new Date();
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function log(msg: string): void {
  try {
    fs.appendFileSync(JEV_DEBUG_LOG, `${getLocalTimestamp()} - ${msg}\n`);
  } catch (_) {
    // never crash the agent loop due to logging failure
  }
}

// ---------------------------------------------------------------------------
// API key
// ---------------------------------------------------------------------------

export function resolveApiKey(): string | undefined {
  return process.env.OPENROUTER_API_KEY;
}

// ---------------------------------------------------------------------------
// Opencode config reading
// ---------------------------------------------------------------------------

export function readOpencodeConfig(): Record<string, unknown> | null {
  try {
    const raw = fs.readFileSync(OPENCODE_JSONC, "utf8");
    return parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}
