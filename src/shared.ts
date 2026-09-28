import os from "os";
import path from "path";

// ---------------------------------------------------------------------------
// Paths (source of truth — um único ponto de definição)
// ---------------------------------------------------------------------------

export function getOpencodeConfigDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  return xdg ? path.join(xdg, "opencode") : path.join(os.homedir(), ".config", "opencode");
}

export const CONFIG_DIR = getOpencodeConfigDir();
export const OPENCODE_JSONC = path.join(CONFIG_DIR, "opencode.jsonc");
export const JEV_DEBUG_LOG = path.join(CONFIG_DIR, "jev_debug.log");
export const JEV_STATE = path.join(CONFIG_DIR, "jev_state.json");
export const JEV_CLASSIFICATIONS = path.join(CONFIG_DIR, "jev_classifications.jsonl");
export const JEV_CONTEXT = path.join(CONFIG_DIR, "jev_context.md");

// ---------------------------------------------------------------------------
// Model string parsing
// ---------------------------------------------------------------------------

// "openrouter/google/gemini-flash-1.5" → { providerID: "openrouter", modelID: "google/gemini-flash-1.5" }
export function parseModelString(model: string): { providerID: string; modelID: string } | null {
  if (!model || !model.includes("/")) return null;
  const idx = model.indexOf("/");
  return {
    providerID: model.substring(0, idx),
    modelID: model.substring(idx + 1),
  };
}

// ---------------------------------------------------------------------------
// MCP server-name normalization
// ---------------------------------------------------------------------------

/** Clean up server name (e.g., "mcp-obsidian" -> "obsidian"). */
export function normalizeMcpServerName(name: string): string {
  return name.replace(/^(mcp-|-mcp)/, "");
}

// ---------------------------------------------------------------------------
// Complexity routing thresholds
// score: 0 (trivial) → 1 (standard) → 2 (complex)
// ---------------------------------------------------------------------------

export const TRIVIAL_THRESHOLD = 0.6;
export const COMPLEX_THRESHOLD = 1.5;

export const ESCALATION_FAILURE_THRESHOLD = 2; // failures before forcing planner
export const FAILURE_WINDOW_MS = 5 * 60 * 1000; // reset counter after 5 min idle

// ---------------------------------------------------------------------------
// Read-only skip-list heuristics (guardrail pre-filter)
// DESIGN PRINCIPLE: this is a skip-list, never an allow-list.
// A false positive here (skipping a dangerous tool) is unsafe.
// A false negative (checking a safe tool with JEV) only costs one API call.
// When in doubt, we CHECK with JEV.
// ---------------------------------------------------------------------------

// Tools that are inherently read-only and carry no destructive potential.
const SAFE_EXACT_NAMES = new Set([
  // OpenCode built-in read/workflow tools (zero destructive potential)
  "read",
  "list",
  "glob",
  "grep",
  "find",
  "webfetch",
  "todowrite",
  "todoread",
  "question",
]);

// Verbs that unambiguously indicate a read-only operation.
const READONLY_VERBS = [
  "list",
  "get",
  "read",
  "search",
  "fetch",
  "view",
  "show",
  "describe",
  "inspect",
  "peek",
  "ping",
];

// Verbs that indicate a mutation. If any of these appears as a whole word in
// the tool name, the tool is NEVER skipped — JEV assesses it.
const WRITE_VERBS = new Set([
  "create",
  "delete",
  "update",
  "set",
  "put",
  "post",
  "patch",
  "drop",
  "remove",
  "write",
  "edit",
  "modify",
  "insert",
  "upsert",
  "destroy",
  "purge",
  "wipe",
  "reset",
  "restart",
  "stop",
  "start",
  "kill",
  "terminate",
  "reboot",
  "recreate",
  "install",
  "uninstall",
  "deploy",
  "move",
  "rename",
  "copy",
  "upload",
  "push",
  "commit",
  "merge",
  "revert",
  "apply",
  "run",
  "execute",
  "send",
  "publish",
  "grant",
  "revoke",
  "enable",
  "disable",
  "block",
  "ban",
  "mute",
  "approve",
  "reject",
  "cancel",
  "close",
  "open",
  "add",
  "append",
  "attach",
  "detach",
  "build",
  "save",
  "launch",
  "shutdown",
  "sync",
  "seed",
  "migrate",
  "rollback",
  "schedule",
  "trigger",
  "invoke",
  "replace",
  "submit",
  "notify",
  "alert",
  "email",
  "broadcast",
  "transmit",
  "activate",
  "deactivate",
  "associate",
  "disassociate",
  "bind",
  "unbind",
  "lock",
  "unlock",
  "freeze",
  "thaw",
  "flush",
  "invalidate",
  "expire",
  "renew",
  "resize",
  "scale",
  "upgrade",
  "downgrade",
  "archive",
  "unarchive",
  "export",
  "import",
  "generate",
  "process",
  "convert",
  "queue",
  "clear",
]);

// Split a tool name into lowercase words, respecting separators AND camelCase.
// "agency-hosting_getWebsiteSetupStatusV1" → [agency, hosting, get, website, setup, status, v1]
export function extractWords(toolName: string): string[] {
  const words: string[] = [];
  for (const segment of toolName.split(/[_\-\s.]+/).filter(Boolean)) {
    const camelSplit = segment.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
    for (const word of camelSplit.split(/\s+/)) {
      if (word) words.push(word.toLowerCase());
    }
  }
  return words;
}

export function isToolSafeReadonly(toolName: string): boolean {
  const raw = toolName.trim();
  const lower = raw.toLowerCase();

  if (SAFE_EXACT_NAMES.has(lower)) return true;

  // 1) Compound operation names are never skipped: "get_or_create",
  //    "search-and-replace", "fetch then remove" — multiple actions implied.
  if (/(^|[_\-\s])(and|or|then)([_\-\s]|$)/i.test(raw)) return false;

  // 2) Word-based write-verb veto.
  //    "setup" is not "set" and "postgres" is not "post" — only whole words count.
  const words = extractWords(raw);
  if (words.some((w) => WRITE_VERBS.has(w))) return false;

  // 3) Fully concatenated lowercase names ("getuseranddelete") can hide verbs
  //    with no word boundaries — apply a coarse substring veto there.
  const concatenated = !/[_\-\s.]/.test(raw) && raw === lower;
  if (concatenated && Array.from(WRITE_VERBS).some((v) => v.length > 3 && lower.includes(v))) {
    return false;
  }

  // 4) Skip only when a candidate name STARTS with a read-only verb word.
  //    Candidates: full name, then name minus 1 and minus 2 leading segments
  //    (server prefixes such as "hosting_", "vps_VPS_", "agency-hosting_").
  const segments = raw.split(/[_\-\s.]+/).filter(Boolean);
  const candidates: string[] = [segments.join(" ")];
  let remaining = segments;
  for (let i = 0; i < 2 && remaining.length > 1; i++) {
    remaining = remaining.slice(1);
    candidates.push(remaining.join(" "));
  }

  return candidates.some((candidate) => {
    const firstWord = extractWords(candidate)[0];
    if (!firstWord) return false;
    return READONLY_VERBS.some((verb) => firstWord === verb || firstWord.startsWith(verb));
  });
}

// ---------------------------------------------------------------------------
// Harvester sampling
// ---------------------------------------------------------------------------

// Error/result text usually lives at the tail of logs; sample head+center/head-out.
export function sampleForHarvest(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const head = Math.min(2000, Math.floor(maxChars * 0.2));
  const tail = maxChars - head;
  return `${text.slice(0, head)}\n[...middle ${text.length - maxChars} chars sampled out...]\n${text.slice(-tail)}`;
}
