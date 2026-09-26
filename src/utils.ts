import fs from "fs";
import os from "os";
import path from "path";
import { parse } from "jsonc-parser";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export function getOpencodeConfigDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  return xdg ? path.join(xdg, "opencode") : path.join(os.homedir(), ".config", "opencode");
}

export const CONFIG_DIR = getOpencodeConfigDir();
export const OPENCODE_JSONC = path.join(CONFIG_DIR, "opencode.jsonc");
export const JEV_DEBUG_LOG = path.join(CONFIG_DIR, "jev_debug.log");

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
// API key resolution
// Priority: env var → opencode.jsonc provider.openrouter.options.apiKey
// ---------------------------------------------------------------------------

export function resolveApiKey(): string | undefined {
  const envKey = process.env.OPENROUTER_API_KEY;
  if (envKey) return envKey;

  try {
    if (fs.existsSync(OPENCODE_JSONC)) {
      const raw = fs.readFileSync(OPENCODE_JSONC, "utf8");
      const config = parse(raw) as Record<string, unknown>;
      const provider = config?.provider as Record<string, unknown> | undefined;
      const openrouter = provider?.openrouter as Record<string, unknown> | undefined;
      const options = openrouter?.options as Record<string, unknown> | undefined;
      const key = options?.apiKey as string | undefined;

      if (key) {
        if (key.startsWith("{env:") && key.endsWith("}")) {
          const envName = key.slice(5, -1);
          return process.env[envName];
        }
        return key;
      }
    }
  } catch (e) {
    log(`Error reading apiKey from opencode.jsonc: ${(e as Error).message}`);
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Config reader
// ---------------------------------------------------------------------------

export function readOpencodeConfig(): Record<string, unknown> | null {
  try {
    if (fs.existsSync(OPENCODE_JSONC)) {
      const raw = fs.readFileSync(OPENCODE_JSONC, "utf8");
      return parse(raw) as Record<string, unknown>;
    }
  } catch (e) {
    log(`Error reading opencode.jsonc: ${(e as Error).message}`);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Model string parser
// Splits "providerID/modelID" — handles multi-segment IDs like
// "openrouter/google/gemini-flash-1.5" → { providerID: "openrouter", modelID: "google/gemini-flash-1.5" }
// ---------------------------------------------------------------------------

export function parseModelString(
  model: string
): { providerID: string; modelID: string } | null {
  if (!model || !model.includes("/")) return null;
  const idx = model.indexOf("/");
  return {
    providerID: model.slice(0, idx),
    modelID: model.slice(idx + 1),
  };
}
