import fs from "fs";
import os from "os";
import path from "path";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { buildDynamicCriteria } from "./catalog.js";
import {
  CONFIG_DIR,
  log,
  getLocalTimestamp,
  resolveApiKey,
  readOpencodeConfig,
  parseModelString,
} from "./utils.js";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// TypeSafe/JEV answer types
// Using the correct primitives per docs:
//   choice  → fixed-set routing (tool domain)
//   score   → ordered rubric (complexity)
//   noul    → probability of yes/no (guardrail checks, failure detection,
//             wrap-up audit)
// ---------------------------------------------------------------------------

interface JevChoiceAnswer {
  type: "choice";
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}

interface JevScoreAnswer {
  type: "score";
  score: number;
  confidence: number;
  probabilities: Record<string, number>;
  legend?: Record<string, string>;
}

interface JevNoulAnswer {
  type: "noul";
  noul: number; // 0.0 = no | 1.0 = yes
}

type JevAnswer = JevChoiceAnswer | JevScoreAnswer | JevNoulAnswer;

interface JevAnswers {
  [key: string]: JevAnswer;
}

interface JevResponse {
  answers: JevAnswers;
}

// ---------------------------------------------------------------------------
// Constants — sentinel protocol + thresholds
// ---------------------------------------------------------------------------

// Completion sentinel: the executor model emits ONLY this token when the whole
// task is done. Detection is a strict whole-message match (free, deterministic).
const TASK_COMPLETE_TOKEN = "[TAREFA_FINALIZADA]";

const WRAPUP_MARKER = "[JEV WRAP-UP]";

const WRAPUP_TRIGGER_TEXT =
  `${WRAPUP_MARKER} The engineering work for this task has been completed and verified by JEV. ` +
  `Write the final user-facing report now: summarize what was done, which files were changed, ` +
  `which commands were run, and the results. Use clear, well-formatted Markdown ` +
  `(tables or HTML when they improve visualization). ` +
  `Do NOT call any tools. Do NOT modify any files. Do NOT emit the completion token. ` +
  `Reply with the report only.`;

const SENTINEL_DIRECTIVE =
  `[JEV COMPLETION PROTOCOL — MANDATORY]\n` +
  `When — and only when — the ENTIRE requested task is complete (all files written, all commands ` +
  `executed, all tests/verifications passed, nothing pending), you MUST end your turn by replying ` +
  `with ONLY this exact token and absolutely nothing else:\n` +
  `${TASK_COMPLETE_TOKEN}\n` +
  `Rules:\n` +
  `- The token must be the sole content of your reply — no explanations, no summaries, no markdown fences.\n` +
  `- A low-cost reporting model will write the final report for the user afterwards.\n` +
  `- NEVER emit the token if any part of the task is incomplete, unverified, or blocked.\n` +
  `- NEVER emit the token when you need to ask the user a question or request input.`;

const WRAPUP_DIRECTIVE =
  `[JEV WRAP-UP DIRECTIVE]\n` +
  `Status: WRAP_UP. The task's engineering work is already complete and was verified by JEV.\n` +
  `Your ONLY job is to write the final user-facing report from the conversation history: ` +
  `what was done, files changed, commands run, and results, in clear formatted Markdown.\n` +
  `Do NOT call any tools. Do NOT modify any files. Do NOT emit the completion token.`;

// Complexity routing thresholds
// score: 0 (trivial) → 1 (standard) → 2 (complex)
const TRIVIAL_THRESHOLD = 0.6;
const COMPLEX_THRESHOLD = 1.5;

const ESCALATION_FAILURE_THRESHOLD = 2;  // failures before forcing planner
const FAILURE_WINDOW_MS = 5 * 60 * 1000; // reset counter after 5 min idle

// ---------------------------------------------------------------------------
// Unified per-session state (JevSessionContext)
// Single source of truth captured at chat.message (original intent) and
// consumed by every other hook. Survives the whole intra-loop reasoning cycle:
// what the agent loses mid-loop, the plugin keeps.
// ---------------------------------------------------------------------------

type JevSessionStatus = "NORMAL" | "ESCALATED" | "WRAP_UP";

interface ToolTrace {
  tool: string;
  failed: boolean;
}

interface JevSessionContext {
  // --- Original intent (captured at first user message, never lost) ---
  originalRequest: string;
  currentModelStr: string;

  // --- Routing decision (recomputed on each real user message) ---
  domain: string;
  domainConfidence: number;
  complexityScore: number;        // 0.0 = trivial → 1.0 = standard → 2.0 = complex
  complexityConfidence: number;
  targetModel: "small" | "core" | "planner";
  targetModelStr: string;
  hasRouting: boolean;

  // --- Guardrail / reactive escalation ---
  failureCount: number;           // consecutive failed tool calls
  lastFailureTimestamp: number;
  forceEscalate: boolean;         // true → next LLM call routes to planner
  blockedToolCalls: number;       // total guardrail blocks this session
  recentTools: ToolTrace[];       // last tool calls (context for wrap-up audit)

  // --- Lifecycle ---
  status: JevSessionStatus;
  wrapUpActive: boolean;          // wrap-up auto-continue cycle in flight
  timestamp: number;              // last activity (for pruning)
}

const sessionContexts = new Map<string, JevSessionContext>();

// Last assistant message text per session (sentinel detection).
// Updated from chat.message (role=assistant) AND message.updated events —
// redundant capture paths, whichever the harness fires.
interface LastAssistantMessage {
  id: string;
  text: string;
  time: number;
}
const lastAssistantBySession = new Map<string, LastAssistantMessage>();

function getContext(sessionID: string): JevSessionContext {
  let ctx = sessionContexts.get(sessionID);
  if (!ctx) {
    ctx = {
      originalRequest: "",
      currentModelStr: "",
      domain: "",
      domainConfidence: 0,
      complexityScore: 1.0,
      complexityConfidence: 0,
      targetModel: "core",
      targetModelStr: "",
      hasRouting: false,
      failureCount: 0,
      lastFailureTimestamp: 0,
      forceEscalate: false,
      blockedToolCalls: 0,
      recentTools: [],
      status: "NORMAL",
      wrapUpActive: false,
      timestamp: Date.now(),
    };
    sessionContexts.set(sessionID, ctx);
  }
  ctx.timestamp = Date.now();
  return ctx;
}

function recordToolTrace(sessionID: string, tool: string, failed: boolean): void {
  const ctx = getContext(sessionID);
  ctx.recentTools.push({ tool, failed });
  if (ctx.recentTools.length > 10) ctx.recentTools.shift();
}

function pruneCache(): void {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [k, v] of sessionContexts) {
    if (v.timestamp < cutoff) sessionContexts.delete(k);
  }
  for (const [k, v] of lastAssistantBySession) {
    if (v.time < cutoff) lastAssistantBySession.delete(k);
  }
  // Also prune sessions with stale failures
  for (const v of sessionContexts.values()) {
    if (v.lastFailureTimestamp > 0 && Date.now() - v.lastFailureTimestamp > FAILURE_WINDOW_MS) {
      v.failureCount = 0;
      v.forceEscalate = false;
      if (v.status === "ESCALATED") v.status = "NORMAL";
    }
  }
}

// ---------------------------------------------------------------------------
// Model routing helpers
// ---------------------------------------------------------------------------

function resolveTargetModel(
  score: number,
  confidence: number,
  smallModel: string,
  plannerModel: string,
  codingModel: string,
  sessionModel: string
): { target: "small" | "core" | "planner"; modelStr: string } {
  // Coding variant of the heavy model — governs the CORE executor when
  // configured; falls back to the session's model otherwise.
  const coreModel = codingModel || sessionModel;
  if (confidence < 0.35) return { target: "core", modelStr: coreModel };
  if (score < TRIVIAL_THRESHOLD && smallModel) return { target: "small", modelStr: smallModel };
  if (score > COMPLEX_THRESHOLD && plannerModel) return { target: "planner", modelStr: plannerModel };
  return { target: "core", modelStr: coreModel };
}

// A provider is usable only if OpenCode can actually serve it: it is either
// declared in opencode.jsonc or has stored auth. Overriding to an unknown
// provider makes the LLM call hang, so we fall back to the core model instead.
function isProviderUsable(providerID: string, config: Record<string, unknown> | null): boolean {
  const configured = new Set<string>();
  const provider = config?.provider as Record<string, unknown> | undefined;
  if (provider) for (const k of Object.keys(provider)) configured.add(k);
  try {
    const authPath = path.join(os.homedir(), ".local", "share", "opencode", "auth.json");
    if (fs.existsSync(authPath)) {
      const auth = JSON.parse(fs.readFileSync(authPath, "utf8")) as Record<string, unknown>;
      for (const k of Object.keys(auth)) configured.add(k);
    }
  } catch (_) {}
  return configured.has(providerID);
}

// ---------------------------------------------------------------------------
// JEV API — shared request runner
// ---------------------------------------------------------------------------

async function jevRequest(
  apiKey: string,
  state: unknown,
  questions: Record<string, unknown>
): Promise<JevAnswers | null> {
  const MAX_RETRIES = 2;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 6000);

      const response = await fetch("https://openrouter.ai/api/alpha/decisions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ model: "typesafe/jev-1.13", state, questions }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const data = (await response.json()) as JevResponse;
      if (data?.answers) return data.answers;

      throw new Error("Malformed JEV response");
    } catch (err) {
      log(`JEV attempt ${attempt + 1} failed: ${(err as Error).message}`);
      if (attempt < MAX_RETRIES - 1) await new Promise((r) => setTimeout(r, 800));
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// JEV query: routing + complexity (called from chat.message)
// ---------------------------------------------------------------------------

async function queryJevRouting(
  apiKey: string,
  messageText: string,
  sessionID: string,
  currentModel: string,
  availableTools: string[]
): Promise<JevAnswers | null> {
  const mcpConfig = readOpencodeConfig()?.mcp as Record<string, unknown> | undefined;
  const criteria = buildDynamicCriteria(mcpConfig);

  const state = {
    user_request: messageText.substring(0, 2000),
    session_context: {
      session_id: sessionID,
      current_model: currentModel,
      workspace: path.basename(process.cwd()),
    },
    available_tools: availableTools,
  };

  const answers = await jevRequest(apiKey, state, {
    next_tool_domain: {
      type: "choice",
      instructions: "Based on user_request and available_tools, which tool domain should be used next?",
      criteria,
    },
    task_complexity: {
      type: "score",
      instructions: "Rate the cognitive complexity and reasoning depth required to fulfill the user_request.",
      criteria: [
        "Trivial: simple text formatting, single-file reads, standard terminal commands, boilerplate generation, or answering basic questions.",
        "Standard: writing new components, refactoring local logic, connecting known APIs, or typical software engineering tasks.",
        "Complex: deep algorithmic debugging, multi-file architecture changes, race condition investigation, cascading failures, or tasks that have failed repeatedly.",
      ],
    },
  });

  if (answers) {
    try {
      fs.appendFileSync(
        path.join(CONFIG_DIR, "jev_classifications.jsonl"),
        JSON.stringify({
          timestamp: getLocalTimestamp(),
          type: "routing",
          sessionID,
          request: messageText.substring(0, 120),
          domain: (answers.next_tool_domain as JevChoiceAnswer)?.choice,
          domainConf: (answers.next_tool_domain as JevChoiceAnswer)?.confidence,
          complexityScore: (answers.task_complexity as JevScoreAnswer)?.score,
          complexityConf: (answers.task_complexity as JevScoreAnswer)?.confidence,
        }) + "\n"
      );
    } catch (_) {}
  }

  return answers;
}

// ---------------------------------------------------------------------------
// JEV query: guardrail (called from tool.execute.before)
// POLYVALENT — works for any tool: built-in (bash, write, edit), MCP tools
// (hosting_hosting_deleteWebsiteV1, vps_VPS_recreateVirtualMachineV1, etc.),
// or any future custom tool.
//
// Key insight: JEV is semantic. We don't need tool-specific logic.
// Sending { tool_name, tool_args } as structured state is sufficient —
// JEV understands what any tool call means from the names and arguments alone.
// ---------------------------------------------------------------------------

// Tools that are inherently read-only and carry no destructive potential.
// We skip JEV for these to avoid unnecessary latency on safe operations.
//
// DESIGN PRINCIPLE: this is a skip-list, never an allow-list.
// A false positive here (skipping a dangerous tool) is unsafe.
// A false negative (checking a safe tool with JEV) only costs one API call.
// When in doubt, we CHECK with JEV.
const SAFE_EXACT_NAMES = new Set([
  // OpenCode built-in read/workflow tools (zero destructive potential)
  "read", "list", "glob", "grep", "find", "webfetch",
  "todowrite", "todoread", "question",
]);

// Verbs that unambiguously indicate a read-only operation.
const READONLY_VERBS = [
  "list", "get", "read", "search", "fetch", "view", "show",
  "describe", "inspect", "peek", "ping",
];

// Verbs that indicate a mutation. If any of these appears as a whole word in
// the tool name, the tool is NEVER skipped — JEV assesses it.
const WRITE_VERBS = new Set([
  "create", "delete", "update", "set", "put", "post", "patch", "drop",
  "remove", "write", "edit", "modify", "insert", "upsert", "destroy",
  "purge", "wipe", "reset", "restart", "stop", "start", "kill", "terminate",
  "reboot", "recreate", "install", "uninstall", "deploy", "move", "rename",
  "copy", "upload", "push", "commit", "merge", "revert", "apply", "run",
  "execute", "send", "publish", "grant", "revoke", "enable", "disable",
  "block", "ban", "mute", "approve", "reject", "cancel", "close", "open",
  "add", "append", "attach", "detach", "build", "save", "launch", "shutdown",
  "sync", "seed", "migrate", "rollback", "schedule", "trigger", "invoke",
  "replace", "submit", "notify", "alert", "email", "broadcast", "transmit",
  "activate", "deactivate", "associate", "disassociate", "bind", "unbind",
  "lock", "unlock", "freeze", "thaw", "flush", "invalidate", "expire",
  "renew", "resize", "scale", "upgrade", "downgrade", "archive", "unarchive",
  "export", "import", "generate", "process", "convert", "queue", "clear",
]);

// Split a tool name into lowercase words, respecting separators AND camelCase.
// "agency-hosting_getWebsiteSetupStatusV1" → [agency, hosting, get, website, setup, status, v1]
function extractWords(toolName: string): string[] {
  const words: string[] = [];
  for (const segment of toolName.split(/[_\-\s.]+/).filter(Boolean)) {
    const camelSplit = segment
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
    for (const word of camelSplit.split(/\s+/)) {
      if (word) words.push(word.toLowerCase());
    }
  }
  return words;
}

function isToolSafeReadonly(toolName: string): boolean {
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
    return READONLY_VERBS.some(
      (verb) => firstWord === verb || firstWord.startsWith(verb)
    );
  });
}

async function queryJevGuardrail(
  apiKey: string,
  tool: string,
  args: Record<string, unknown>
): Promise<{ isDangerous: number } | null> {
  // Generic polyvalent state: works for bash, write, edit, AND any MCP tool.
  // JEV receives the full tool name and serialized args — enough semantic
  // context to assess any action regardless of its origin.
  const state = {
    tool_name: tool,
    tool_args: JSON.stringify(args).substring(0, 3000),
  };

  const answers = await jevRequest(apiKey, state, {
    is_dangerous: {
      type: "noul",
      instructions:
        "Could this tool call cause data loss, modify or delete production systems, expose credentials, or perform an irreversible destructive action?",
      criteria: {
        true: "Tool call deletes or overwrites files/directories, drops databases, destroys VPS/hosting instances, wipes DNS records, deletes websites or domains, runs destructive shell commands (rm -rf, format, DROP TABLE), exposes API keys or credentials, modifies OS/system configuration, or performs any action that cannot be easily undone.",
        false: "Tool call reads or lists data, creates new resources without affecting existing ones, installs project-local packages, runs tests, starts development servers, or performs standard reversible development operations.",
      },
    },
  });

  if (!answers) return null;
  const noulAnswer = answers.is_dangerous as JevNoulAnswer | undefined;
  return noulAnswer ? { isDangerous: noulAnswer.noul } : null;
}

// ---------------------------------------------------------------------------
// JEV query: failure detection (called from tool.execute.after)
// POLYVALENT — monitors output from any tool: bash, MCP calls, custom tools.
// Uses noul — "Does this output indicate an error or failure?"
// This is the reactive mid-loop escalation trigger.
// ---------------------------------------------------------------------------

async function queryJevFailureDetect(
  apiKey: string,
  tool: string,
  toolTitle: string,
  toolArgs: unknown,
  toolOutput: string
): Promise<{ isFailure: number } | null> {
  const state = {
    tool_name: tool,
    tool_summary: toolTitle || undefined,
    tool_args: toolArgs ? JSON.stringify(toolArgs).substring(0, 1500) : undefined,
    output: toolOutput.substring(0, 4000),
  };

  const answers = await jevRequest(apiKey, state, {
    is_failure: {
      type: "noul",
      instructions:
        "Does this tool output indicate an error, failure, or unexpected result that the agent needs to address?",
      criteria: {
        true: "Output contains error messages, stack traces, non-zero exit codes, build failures, test failures, unhandled exceptions, permission denied errors, command not found, API error responses, rejected operations, or syntax errors.",
        false: "Output shows successful execution, expected results, normal warnings that don't indicate failure, or empty output from commands that normally produce none.",
      },
    },
  });

  if (!answers) return null;

  const noulAnswer = answers.is_failure as JevNoulAnswer | undefined;
  return noulAnswer ? { isFailure: noulAnswer.noul } : null;
}

// ---------------------------------------------------------------------------
// JEV query: wrap-up audit (called from session.idle, after sentinel detection)
// Auditor layer against premature completion signals: the sentinel token is the
// cheap primary trigger; this noul double-checks it before de-escalating.
// ---------------------------------------------------------------------------

async function queryJevWrapUpAudit(
  apiKey: string,
  ctx: JevSessionContext
): Promise<{ isComplete: number } | null> {
  const state = {
    user_request: ctx.originalRequest.substring(0, 1500),
    agent_signal: TASK_COMPLETE_TOKEN,
    recent_tools: ctx.recentTools.map((t) => `${t.tool}:${t.failed ? "fail" : "ok"}`),
    consecutive_failures: ctx.failureCount,
  };

  const answers = await jevRequest(apiKey, state, {
    task_fully_complete: {
      type: "noul",
      instructions:
        "The executor agent has just signaled that the requested task is fully finished. Based on the original request, recent tool activity, and failure count, is the task genuinely complete?",
      criteria: {
        true: "The original user request has been fully satisfied: required changes or outputs were produced, verifications succeeded, recent tools confirm the work, and no failures are pending.",
        false: "Work appears unfinished: the request was only partially addressed, recent tools show errors or unresolved failures, or the completion signal contradicts the evidence.",
      },
    },
  });

  if (!answers) return null;
  const noulAnswer = answers.task_fully_complete as JevNoulAnswer | undefined;
  return noulAnswer ? { isComplete: noulAnswer.noul } : null;
}

// ---------------------------------------------------------------------------
// Wrap-up auto-continue (de-escalation)
// Fires when the sentinel token is detected at session.idle. Hands the final
// report generation (the 1-2 "wrap-up" reasoning cycles) to the cheap model,
// which reads the full session history and writes the user-facing report.
// ---------------------------------------------------------------------------

async function triggerWrapUp(client: any, sessionID: string): Promise<void> {
  const ctx = getContext(sessionID);

  // Text generation role: the report model is the "good writer" among the
  // cheap models (falls back to small_model, then to the session's model).
  const config = readOpencodeConfig();
  const models = readJevModels();
  const parsedReport = models.reportModel ? parseModelString(models.reportModel) : null;

  const reportUsable = !!(parsedReport && isProviderUsable(parsedReport.providerID, config));
  const fallback = parseModelString(ctx.currentModelStr || "");

  // Prefer the dedicated report model; fall back to the session's model so the
  // report is still delivered even when it is not configured/authorized.
  const modelToUse = reportUsable
    ? parsedReport
    : fallback && isProviderUsable(fallback.providerID, config)
    ? fallback
    : null;

  if (!modelToUse) {
    log("WRAP-UP aborted: no usable model found for the report cycle.");
    return;
  }

  ctx.status = "WRAP_UP";
  ctx.wrapUpActive = true;

  log(
    `WRAP-UP: auto-continue on session ${sessionID} → ` +
    `${modelToUse.providerID}/${modelToUse.modelID} (${reportUsable ? "report_model" : "fallback core"})`
  );

  try {
    fs.appendFileSync(
      path.join(CONFIG_DIR, "jev_classifications.jsonl"),
      JSON.stringify({
        timestamp: getLocalTimestamp(),
        type: "wrap_up",
        sessionID,
        request: `[WRAP-UP] report cycle → ${modelToUse.providerID}/${modelToUse.modelID}`,
        domain: "WRAP_UP",
        domainConf: 1,
      }) + "\n"
    );
  } catch (_) {}

  try {
    await client.session.prompt({
      path: { id: sessionID },
      body: {
        model: { providerID: modelToUse.providerID, modelID: modelToUse.modelID },
        parts: [{ type: "text", text: WRAPUP_TRIGGER_TEXT }],
      },
    });
    log("WRAP-UP: report cycle finished.");
  } catch (err) {
    log(`WRAP-UP prompt failed: ${(err as Error).message}`);
    ctx.wrapUpActive = false;
    ctx.status = "NORMAL";
  }
}

// ---------------------------------------------------------------------------
// Context Harvester — micro-worker
// Large tool outputs are compressed by the small model inside an isolated
// child session (JEV hooks never fire on it). The raw output is archived to
// jev_harvests.jsonl and the compressed version replaces it inline, so the
// core model never burns context on log noise.
// ---------------------------------------------------------------------------

interface HarvesterConfig {
  enabled: boolean;
  thresholdChars: number;   // only outputs >= this are harvested
  maxInputChars: number;    // cap of raw text sent to the small model
  timeoutMs: number;        // hard deadline; on timeout the raw output is kept
}

const HARVESTER_DEFAULTS: HarvesterConfig = {
  enabled: true,
  thresholdChars: 3000,
  maxInputChars: 12000,
  timeoutMs: 25000,
};

function getHarvesterConfig(jevState: { harvester?: Partial<HarvesterConfig> }): HarvesterConfig {
  return { ...HARVESTER_DEFAULTS, ...(jevState.harvester ?? {}) };
}

// Sessions spawned by the harvester — our hooks must never fire on them.
// IDs are kept forever (the server-side session is deleted after each run).
const harvestSessionIds = new Set<string>();

// Tools whose output is structured content (files, todos), not execution logs.
const HARVEST_SKIP_TOOLS = new Set([
  "read", "glob", "grep", "list", "todoread", "todowrite", "question", "edit", "write",
]);

const HARVEST_SYSTEM_PROMPT = [
  "You are JEV-HARVESTER, a deterministic micro-worker that compresses raw tool output before it reaches the primary reasoning model.",
  "Rules (strict):",
  "- Preserve VERBATIM: error messages, stack traces, exit codes, file paths, env var names, command lines, identifiers.",
  "- Drop noise: progress bars, spinner frames, repeated lines (emit \"[...N similar lines omitted]\"), banners, ANSI escape codes, raw HTML.",
  "- Output format (plain text, no markdown fences):",
  "  STATUS: success | failure | ambiguous",
  "  ERRORS: <exact error lines, or \"none\">",
  "  SUMMARY: <1-5 compact lines>",
  "  KEY DATA: <essential values/paths/json projections>",
  "- Hard cap ~40 lines. Never invent content. Never call tools. Reply with the compressed text only.",
].join("\n");

// Error/result text usually lives at the tail of logs; sample head+center/head-out.
function sampleForHarvest(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const head = Math.min(2000, Math.floor(maxChars * 0.2));
  const tail = maxChars - head;
  return `${text.slice(0, head)}\n[...middle ${text.length - maxChars} chars sampled out...]\n${text.slice(-tail)}`;
}

async function harvestToolOutput(
  client: any,
  parentSessionID: string,
  tool: string,
  args: unknown,
  rawOutput: string,
  smallModel: string,
  cfg: HarvesterConfig
): Promise<string | null> {
  if (!client?.session) { log("HARVEST skipped: no OpenCode client in plugin context."); return null; }
  const parsedModel = parseModelString(smallModel);
  if (!parsedModel) { log(`HARVEST skipped: invalid harvester_model "${smallModel}"`); return null; }

  const payload = sampleForHarvest(rawOutput, cfg.maxInputChars);
  const argsPreview = args ? JSON.stringify(args).substring(0, 500) : "";

  let childID: string | null = null;
  const startedAt = Date.now();

  const work = async (): Promise<string | null> => {
    const created = await client.session.create({
      body: { parentID: parentSessionID, title: `jev-harvester:${tool}` },
    });
    childID = created?.data?.id ?? null;
    if (!childID) return null;
    harvestSessionIds.add(childID);

    const resp = await client.session.prompt({
      path: { id: childID },
      body: {
        model: { providerID: parsedModel.providerID, modelID: parsedModel.modelID },
        system: HARVEST_SYSTEM_PROMPT,
        parts: [{
          type: "text",
          text: `TOOL: ${tool}\nARGS: ${argsPreview}\n--- RAW OUTPUT (${rawOutput.length} chars) ---\n${payload}`,
        }],
      },
    });
    if (resp?.error) throw new Error(JSON.stringify(resp.error));

    const parts = resp?.data?.parts ?? [];
    return (
      parts
        .filter((p: any) => p?.type === "text" && typeof p.text === "string")
        .map((p: any) => p.text)
        .join("\n")
        .trim() || null
    );
  };

  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`harvest timeout after ${cfg.timeoutMs}ms`)), cfg.timeoutMs)
  );

  try {
    const summary = await Promise.race([work(), timeout]);
    log(`HARVEST [${tool}] ${rawOutput.length} -> ${summary?.length ?? 0} chars in ${Date.now() - startedAt}ms`);
    return summary;
  } catch (err) {
    log(`HARVEST [${tool}] failed: ${(err as Error).message}`);
    return null;
  } finally {
    if (childID) {
      try { await client.session.delete({ path: { id: childID } }); } catch (_) {}
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers — read jev_state.json (enabled flags etc.)
// ---------------------------------------------------------------------------

function readJevState(): Record<string, any> {
  try {
    const jevStatePath = path.join(CONFIG_DIR, "jev_state.json");
    if (fs.existsSync(jevStatePath)) {
      return JSON.parse(fs.readFileSync(jevStatePath, "utf8")) as Record<string, any>;
    }
  } catch (_) {}
  return {};
}

// ---------------------------------------------------------------------------
// Model role resolution (opencode.jsonc → "jev" object)
// Small models are specialized: good collectors are not always good text
// generators, so harvester and report roles have dedicated keys with the
// generic small_model as fallback. The heavy model has two variants:
// planner (thinking/architecture) and coding (fast execution).
//
//   jev.harvesterModel → Context Harvester (coletor de traces/logs)
//   jev.reportModel    → wrap-up report generator (gerador de rich text)
//   jev.plannerModel   → heavy variant — planning/escalation
//   jev.codingModel    → heavy variant — core coding executor
// ---------------------------------------------------------------------------

interface JevModelConfig {
  smallModel: string;      // generic small fallback (small_model)
  harvesterModel: string;  // coletor
  reportModel: string;     // gerador de texto (wrap-up)
  plannerModel: string;    // heavy: planning variant
  codingModel: string;     // heavy: coding variant
}

function readJevModels(): JevModelConfig {
  const config = readOpencodeConfig();
  const jev = (config?.jev as Record<string, unknown> | undefined) ?? {};
  const smallModel = (config?.small_model as string) || "";
  return {
    smallModel,
    harvesterModel: (jev.harvesterModel as string) || smallModel,
    reportModel: (jev.reportModel as string) || smallModel,
    plannerModel:
      (jev.plannerModel as string) ||
      ((config?.agent as any)?.plan?.model as string) ||
      "",
    codingModel: (jev.codingModel as string) || "",
  };
}

// Defensive extraction of a message object from an event payload.
// Payload shapes vary between opencode versions ({ info }, { message }, or
// the message itself) — try all known paths.
function extractMessageFromEvent(properties: any): any | null {
  if (!properties) return null;
  if (properties.message) return properties.message;
  if (properties.info) return properties.info;
  if ((properties.id || properties.messageID) && (properties.parts || properties.role)) return properties;
  return null;
}

// ---------------------------------------------------------------------------
// Plugin export
// ---------------------------------------------------------------------------

export default (async (ctx: unknown) => {
  const client = (ctx as any)?.client;

  // Autostart web dashboard silently
  try {
    const dashboardPath = path.join(moduleDir, "dashboard.js");
    if (fs.existsSync(dashboardPath)) {
      const p = spawn(process.execPath, [dashboardPath], { detached: true, stdio: "ignore" });
      p.unref();
    }
  } catch (e) {
    log(`Dashboard autostart failed: ${(e as Error).message}`);
  }

  return {
    // -------------------------------------------------------------------------
    // Hook 0: event — SENTINEL DETECTION + WRAP-UP TRIGGER
    // Tracks the last assistant message per session (redundantly with
    // chat.message's role=assistant branch) and, on session.idle, checks for
    // the completion token. Token + Noul audit → de-escalation (wrap-up).
    // -------------------------------------------------------------------------
    "event": async ({ event }: { event: { type: string; properties?: any } }) => {
      try {
        if (event.type === "message.updated" || event.type === "message.part.updated") {
          const msg = extractMessageFromEvent(event.properties);
          if (!msg) return;
          if (msg.role !== "assistant") return;
          const sessionID = msg.sessionID ?? event.properties?.sessionID;
          if (!sessionID || harvestSessionIds.has(sessionID)) return;

          const text = (msg.parts ?? [])
            .filter((p: any) => p?.type === "text" && typeof p.text === "string")
            .map((p: any) => p.text)
            .join("")
            .trim();

          lastAssistantBySession.set(sessionID, {
            id: msg.id ?? "",
            text,
            time: Date.now(),
          });
          return;
        }

        if (event.type === "session.idle") {
          const sessionID =
            event.properties?.sessionID ?? event.properties?.id ?? event.properties?.session?.id;
          if (!sessionID || harvestSessionIds.has(sessionID)) return;

          const jevState = readJevState();
          if (jevState.enabled !== true) return;

          const ctxS = getContext(sessionID);

          // A wrap-up report cycle just finished (or another turn ended while
          // wrap-up was in flight): restore NORMAL so the next real user
          // message gets fresh classification.
          if (ctxS.wrapUpActive) {
            log("WRAP-UP report cycle complete. Restoring NORMAL status.");
            ctxS.wrapUpActive = false;
            ctxS.status = "NORMAL";
            return;
          }

          const last = lastAssistantBySession.get(sessionID);
          const lastText = (last?.text ?? "").trim();
          if (lastText !== TASK_COMPLETE_TOKEN) return;

          log(`SENTINEL detected: assistant signaled task completion on session ${sessionID}.`);

          // Auditor layer: one cheap noul double-check against premature
          // completion. If the JEV API is unavailable, trust the token.
          const apiKey = resolveApiKey();
          if (apiKey) {
            const audit = await queryJevWrapUpAudit(apiKey, ctxS);
            if (audit) {
              log(`WRAP-UP AUDIT: complete_probability=${audit.isComplete.toFixed(2)}`);
              try {
                fs.appendFileSync(
                  path.join(CONFIG_DIR, "jev_classifications.jsonl"),
                  JSON.stringify({
                    timestamp: getLocalTimestamp(),
                    type: "wrap_up_audit",
                    sessionID,
                    isComplete: audit.isComplete,
                    accepted: audit.isComplete >= 0.5,
                  }) + "\n"
                );
              } catch (_) {}

              if (audit.isComplete < 0.5) {
                log("WRAP-UP AUDIT rejected the completion signal. Keeping the current model.");
                return;
              }
            }
          }

          await triggerWrapUp(client, sessionID);
        }
      } catch (err) {
        log(`event error: ${(err as Error).message}`);
      }
    },

    // -------------------------------------------------------------------------
    // Hook 1: chat.message
    // Fires when a message arrives. For user messages: runs the routing +
    // complexity classification and seeds the unified JevSessionContext with
    // the ORIGINAL intent (so it survives the whole intra-loop). For
    // assistant messages: feeds the sentinel tracker. For the injected
    // wrap-up message: bypasses classification entirely.
    // Redundant model override (primary vector); system.transform re-applies.
    // -------------------------------------------------------------------------
    "chat.message": async (
      input: {
        sessionID: string;
        agent?: string;
        model?: { providerID: string; modelID: string };
        messageID?: string;
        variant?: string;
      },
      output: {
        message: {
          id: string;
          sessionID: string;
          role: string;
          agent: string;
          model: { providerID: string; modelID: string };
          system?: string;
          tools?: Record<string, boolean>;
        };
        parts: Array<{ type: string; text?: string; [key: string]: unknown }>;
      }
    ) => {
      try {
        pruneCache();
        if (harvestSessionIds.has(input.sessionID)) return;
        log(`--- chat.message | session: ${input.sessionID} ---`);

        const jevState = readJevState();
        if (jevState.enabled !== true) { log("Bypass: JEV disabled."); return; }

        // --- Sentinel tracker: assistant messages are captured, not classified.
        if (output.message?.role === "assistant") {
          const text = output.parts
            .filter((p) => p.type === "text" && typeof p.text === "string")
            .map((p) => p.text as string)
            .join("")
            .trim();
          lastAssistantBySession.set(input.sessionID, {
            id: output.message.id ?? "",
            text,
            time: Date.now(),
          });
          return;
        }

        // Extract user message text from output.parts
        const textParts = output.parts
          .filter((p) => p.type === "text" && typeof p.text === "string")
          .map((p) => p.text as string);

        if (!textParts.length) { log("Bypass: no text parts."); return; }
        const messageText = textParts.join("\n").trim();
        if (!messageText) { log("Bypass: empty message."); return; }

        // --- Wrap-up injected message: keep WRAP_UP status, bypass classification.
        if (messageText.startsWith(WRAPUP_MARKER)) {
          log("WRAP-UP cycle message detected — bypassing classification.");
          return;
        }

        const ctxS = getContext(input.sessionID);

        // A new REAL user message starts a fresh task cycle: clear lifecycle
        // flags so stale escalation/wrap-up state never leaks into new intents.
        ctxS.status = "NORMAL";
        ctxS.wrapUpActive = false;
        ctxS.forceEscalate = false;
        ctxS.failureCount = 0;

        const apiKey = resolveApiKey();
        if (!apiKey) { log("Bypass: no API key."); return; }

        log(`Message (preview): ${messageText.substring(0, 100)}`);

        const config = readOpencodeConfig();
        const currentModelObj = input.model ?? output.message.model ?? { providerID: "unknown", modelID: "unknown" };
        const currentModelStr = `${currentModelObj.providerID}/${currentModelObj.modelID}`;
        const models = readJevModels();
        const availableTools = Object.keys(buildDynamicCriteria(config?.mcp as Record<string, unknown> | undefined));

        // --- Capture the original intent BEFORE anything else can fail ---
        ctxS.originalRequest = messageText.substring(0, 2000);
        ctxS.currentModelStr = currentModelStr;

        // Call JEV for routing + complexity
        const answers = await queryJevRouting(
          apiKey, messageText, input.sessionID, currentModelStr, availableTools
        );

        if (!answers?.next_tool_domain) { log("JEV returned no answers."); return; }

        const domainAns = answers.next_tool_domain as JevChoiceAnswer;
        const compAns = answers.task_complexity as JevScoreAnswer | undefined;

        const threshold = jevState.confidenceThreshold ?? 0.6;
        const complexityScore = compAns?.score ?? 1.0;
        const complexityConf = compAns?.confidence ?? 0;

        log(`Domain: ${domainAns.choice} (conf: ${domainAns.confidence.toFixed(2)})`);
        log(`Complexity: score=${complexityScore.toFixed(2)} conf=${complexityConf.toFixed(2)}`);

        const routing = resolveTargetModel(
          complexityScore, complexityConf,
          models.smallModel, models.plannerModel, models.codingModel, currentModelStr
        );

        // Guard: never override to a provider OpenCode cannot serve, otherwise
        // the LLM call hangs waiting for a non-existent provider/model.
        // Applies to small/planner targets AND to the coding-variant override
        // of the core target.
        if (routing.target !== "core" || routing.modelStr !== currentModelStr) {
          const parsedTarget = parseModelString(routing.modelStr);
          if (!parsedTarget || !isProviderUsable(parsedTarget.providerID, config)) {
            log(`Override skipped: provider "${parsedTarget?.providerID ?? routing.modelStr}" not configured/authorized. Keeping session model.`);
            routing.target = "core";
            routing.modelStr = currentModelStr;
          }
        }
        log(`Routing → ${routing.target.toUpperCase()} (${routing.modelStr})`);

        // Cache the full decision for system.transform (consumed on every
        // subsequent intra-loop LLM call).
        ctxS.domain = domainAns.choice;
        ctxS.domainConfidence = domainAns.confidence;
        ctxS.complexityScore = complexityScore;
        ctxS.complexityConfidence = complexityConf;
        ctxS.targetModel = routing.target;
        ctxS.targetModelStr = routing.modelStr;
        ctxS.hasRouting = true;

        // Update stats
        try {
          jevState.stats = jevState.stats ?? { totalCalls: 0, models: {} };
          jevState.stats.totalCalls = (jevState.stats.totalCalls || 0) + 1;
          jevState.stats.models = jevState.stats.models ?? {};
          jevState.stats.models[routing.target] = (jevState.stats.models[routing.target] || 0) + 1;
          fs.writeFileSync(path.join(CONFIG_DIR, "jev_state.json"), JSON.stringify(jevState, null, 2));
        } catch (_) {}

        // Model swap: override output.message.model (primary mechanism)
        if (routing.target !== "core" && domainAns.confidence >= threshold) {
          const parsed = parseModelString(routing.modelStr);
          if (parsed) {
            log(`Model override → providerID: "${parsed.providerID}" modelID: "${parsed.modelID}"`);
            output.message.model = { providerID: parsed.providerID, modelID: parsed.modelID };
          }
        }
      } catch (err) {
        log(`chat.message error: ${(err as Error).message}`);
      }
    },

    // -------------------------------------------------------------------------
    // Hook 2: tool.execute.before  — POLYVALENT GUARDRAIL
    // Canonical use case from TypeSafe docs: "LLM guardrails"
    // "Place semantic checks on every tool call at a fraction of the cost."
    //
    // Works for ANY tool: bash, write, edit, every MCP tool, any custom tool.
    // Skips provably read-only tools to avoid needless latency.
    // Logs all dangerous detections.
    // Blocks only if jev_state.blockDangerous = true (opt-in).
    // -------------------------------------------------------------------------
    "tool.execute.before": async (
      input: { tool: string; sessionID: string; callID: string },
      output: { args: Record<string, unknown> }
    ) => {
      try {
        if (harvestSessionIds.has(input.sessionID)) return;

        const jevState = readJevState();
        if (jevState.enabled !== true) return;

        // Polyvalent skip: only bypass tools that are provably read-only.
        // Everything else — bash, write, edit, MCP mutations, custom tools —
        // is checked semantically by JEV.
        if (isToolSafeReadonly(input.tool)) {
          log(`GUARDRAIL skip (read-only) [${input.tool}]`);
          return;
        }

        const apiKey = resolveApiKey();
        if (!apiKey) return;

        const result = await queryJevGuardrail(apiKey, input.tool, output.args);
        if (!result) return;

        const { isDangerous } = result;
        log(`GUARDRAIL [${input.tool}] danger_probability=${isDangerous.toFixed(2)}`);

        if (isDangerous > 0.80) {
          // Log the detection
          try {
            fs.appendFileSync(
              path.join(CONFIG_DIR, "jev_classifications.jsonl"),
              JSON.stringify({
                timestamp: getLocalTimestamp(),
                type: "guardrail",
                sessionID: input.sessionID,
                tool: input.tool,
                args: output.args,
                isDangerous,
              }) + "\n"
            );
          } catch (_) {}

          // Update guardrail stats
          const ctxS = getContext(input.sessionID);
          ctxS.blockedToolCalls++;

          if (jevState.blockDangerous) {
            // Hard block: throw prevents the tool from running
            throw new Error(
              `[JEV GUARDRAIL] Potentially destructive action blocked (danger: ${(isDangerous * 100).toFixed(0)}%). ` +
              `Tool: ${input.tool}. Disable blocking with \`opencode-jev panel\`.`
            );
          }

          log(`GUARDRAIL WARNING: danger=${(isDangerous * 100).toFixed(0)}% — logging only (blockDangerous=false).`);
        }
      } catch (err) {
        // Re-throw if it's our own guardrail block; swallow all other errors
        if ((err as Error).message?.startsWith("[JEV GUARDRAIL]")) throw err;
        log(`tool.execute.before error: ${(err as Error).message}`);
      }
    },

    // -------------------------------------------------------------------------
    // Hook 3: tool.execute.after  — POLYVALENT REACTIVE ESCALATION
    // Canonical use case from TypeSafe docs: "Harness Engineering"
    // "Classify agent traces, detect errors in real time."
    //
    // Monitors the output of ANY tool — bash, MCP calls, custom tools.
    // Consecutive failures → forceEscalate flag → system.transform escalates
    // the NEXT LLM call (even mid-loop) to the Planner model.
    // Consecutive successes after a rescue → de-escalate back to NORMAL.
    // -------------------------------------------------------------------------
    "tool.execute.after": async (
      input: { tool: string; sessionID: string; callID: string; args: unknown },
      output: { title: string; output: string; metadata: unknown }
    ) => {
      try {
        if (harvestSessionIds.has(input.sessionID)) return;

        // Local content tools: output is data, not an execution result.
        // (MCP read tools are NOT skipped — their API errors matter.)
        const LOCAL_CONTENT_TOOLS = new Set(["read", "glob", "grep", "list", "todoread"]);

        const jevStatePath = path.join(CONFIG_DIR, "jev_state.json");
        let jevState: any = { enabled: false, stats: { totalCalls: 0, models: {} } };
        try {
          if (fs.existsSync(jevStatePath)) {
            jevState = { ...jevState, ...JSON.parse(fs.readFileSync(jevStatePath, "utf8")) };
          }
        } catch (_) {}

        if (!jevState.enabled) return;

        // Skip very short outputs (usually successful with no output)
        const toolOutput = (output.output ?? "").trim();
        if (toolOutput.length < 10) return;

        const apiKey = resolveApiKey();

        // Worker 1: failure detection → reactive escalation (needs OpenRouter key)
        const failurePromise = (async () => {
          if (!apiKey || LOCAL_CONTENT_TOOLS.has(input.tool)) return;

          const result = await queryJevFailureDetect(
            apiKey,
            input.tool,
            output.title,
            input.args,
            toolOutput
          );
          if (!result) return;

          const { isFailure } = result;
          log(`FAILURE DETECT [${input.tool}] failure_probability=${isFailure.toFixed(2)}`);

          const ctxS = getContext(input.sessionID);
          recordToolTrace(input.sessionID, input.tool, isFailure > 0.5);

          if (isFailure > 0.78) {
            ctxS.failureCount++;
            ctxS.lastFailureTimestamp = Date.now();

            log(`Session ${input.sessionID} failure count: ${ctxS.failureCount}/${ESCALATION_FAILURE_THRESHOLD}`);

            try {
              fs.appendFileSync(
                path.join(CONFIG_DIR, "jev_classifications.jsonl"),
                JSON.stringify({
                  timestamp: getLocalTimestamp(),
                  type: "failure_detect",
                  sessionID: input.sessionID,
                  tool: input.tool,
                  isFailure,
                  failureCount: ctxS.failureCount,
                }) + "\n"
              );
            } catch (_) {}

            if (ctxS.failureCount >= ESCALATION_FAILURE_THRESHOLD) {
              // Set the reactive escalation flag. system.transform consumes it
              // on the next LLM call — INCLUDING intra-loop calls — forcing the
              // Planner model without waiting for a new user message.
              ctxS.forceEscalate = true;
              ctxS.status = "ESCALATED";
              log(
                `REACTIVE ESCALATION TRIGGERED: ${ctxS.failureCount} consecutive failures → ` +
                `next LLM call will force the Planner model.`
              );
            }
          } else if (isFailure < 0.30) {
            // Successful tool call — gradually reset failure counter
            if (ctxS.failureCount > 0) {
              ctxS.failureCount = Math.max(0, ctxS.failureCount - 1);
              log(`Failure counter decremented → ${ctxS.failureCount} (successful tool call)`);
            }
            // De-escalation: the rescue model fixed the problem (successes
            // resumed) — stop burning the expensive planner on every cycle.
            if (ctxS.status === "ESCALATED" && ctxS.failureCount === 0 && !ctxS.forceEscalate) {
              ctxS.status = "NORMAL";
              log("DE-ESCALATION: consecutive successes after rescue — restoring NORMAL routing.");
            }
          }
        })();

        // Worker 2: context harvester — the COLLECTOR small model compresses
        // large outputs (specialized role: fast extraction, verbatim fidelity)
        const cfg = getHarvesterConfig(jevState);
        const harvestPromise = (async (): Promise<string | null> => {
          if (!cfg.enabled) return null;
          if (HARVEST_SKIP_TOOLS.has(input.tool)) return null;
          if (toolOutput.length < cfg.thresholdChars) return null;

          const models = readJevModels();
          const harvesterModelStr = models.harvesterModel;
          const parsedModel = harvesterModelStr ? parseModelString(harvesterModelStr) : null;
          if (!parsedModel || !isProviderUsable(parsedModel.providerID, readOpencodeConfig())) {
            log(`HARVEST skipped: harvester_model "${harvesterModelStr}" not configured/authorized.`);
            return null;
          }

          return harvestToolOutput(client, input.sessionID, input.tool, input.args, toolOutput, harvesterModelStr, cfg);
        })();

        const [, summary] = await Promise.all([failurePromise, harvestPromise]);

        if (summary) {
          // Archive the raw output, then replace it inline with the compressed version.
          try {
            fs.appendFileSync(
              path.join(CONFIG_DIR, "jev_harvests.jsonl"),
              JSON.stringify({
                timestamp: getLocalTimestamp(),
                sessionID: input.sessionID,
                tool: input.tool,
                chars: toolOutput.length,
                args: input.args ? JSON.stringify(input.args).substring(0, 400) : undefined,
                raw: toolOutput,
              }) + "\n"
            );
          } catch (_) {}

          output.output =
            `[JEV CONTEXT HARVESTER — ${toolOutput.length} → ${summary.length} chars | raw archived in jev_harvests.jsonl]\n\n` +
            summary;

          try {
            jevState.stats = jevState.stats ?? {};
            jevState.stats.harvests = (jevState.stats.harvests ?? 0) + 1;
            jevState.stats.charsSaved = (jevState.stats.charsSaved ?? 0) + Math.max(0, toolOutput.length - summary.length);
            fs.writeFileSync(jevStatePath, JSON.stringify(jevState, null, 2));
          } catch (_) {}

          try {
            fs.appendFileSync(
              path.join(CONFIG_DIR, "jev_classifications.jsonl"),
              JSON.stringify({
                timestamp: getLocalTimestamp(),
                type: "harvest",
                sessionID: input.sessionID,
                tool: input.tool,
                request: `[HARVEST] ${input.tool}: ${toolOutput.length} → ${summary.length} chars`,
                domain: "HARVEST",
                domainConf: 1,
              }) + "\n"
            );
          } catch (_) {}
        }
      } catch (err) {
        log(`tool.execute.after error: ${(err as Error).message}`);
      }
    },

    // -------------------------------------------------------------------------
    // Hook 4: experimental.chat.system.transform
    // Fires just before EVERY LLM call — first call AND every intra-loop
    // reasoning cycle. This is the authoritative, always-on router:
    //
    //   status WRAP_UP   → keep the cheap model, inject the report directive
    //   forceEscalate    → mutate to the Planner + inject the rescue directive
    //   cached routing   → re-apply model + inject routing directive (redundant
    //                      with chat.message's override, covering intra-loop)
    //   every non-wrap-up cycle → inject the sentinel completion protocol
    // -------------------------------------------------------------------------
    "experimental.chat.system.transform": async (
      input: { sessionID?: string; model: unknown },
      output: { system: string[] }
    ) => {
      try {
        if (!input.sessionID) return;
        if (harvestSessionIds.has(input.sessionID)) return;
        log(`--- system.transform | session: ${input.sessionID} ---`);

        const jevState = readJevState();
        if (jevState.enabled !== true) return;

        const ctxS = getContext(input.sessionID);

        // Inject persistent context basket (anti-amnesia memory)
        try {
          const contextPath = path.join(process.cwd(), ".opencode", "jev_context.md");
          if (fs.existsSync(contextPath)) {
            const ctxBasket = fs.readFileSync(contextPath, "utf8").trim();
            if (ctxBasket) {
              output.system.push(
                `[JEV CONTEXT BASKET / MEMORY]\n${ctxBasket}\n(Update: \`opencode-jev context "text"\`)`
              );
              log("Context basket injected.");
            }
          }
        } catch (_) {}

        // ---------------------------------------------------------------------
        // WRAP_UP: the cheap report cycle. No routing directive, no sentinel
        // directive (anti-loop), no model mutation — the wrap-up prompt body
        // already pinned the small model.
        // ---------------------------------------------------------------------
        if (ctxS.status === "WRAP_UP") {
          output.system.push(WRAPUP_DIRECTIVE);
          log("Directive pushed. WRAP_UP (report cycle).");
          return;
        }

        // ---------------------------------------------------------------------
        // REACTIVE ESCALATION (mid-loop): consume the forceEscalate flag and
        // mutate THIS LLM call to the Planner model, with a rescue directive
        // carrying the original intent — no new user message required.
        // ---------------------------------------------------------------------
        if (ctxS.forceEscalate) {
          ctxS.forceEscalate = false; // consume the escalation flag
          ctxS.status = "ESCALATED";
          log(
            `REACTIVE ESCALATION: forcing Planner model mid-loop ` +
            `(after ${ctxS.failureCount} consecutive tool failures).`
          );

          // Heavy model — planning variant (deep reasoning/architecture).
          const models = readJevModels();
          const parsedPlanner = models.plannerModel ? parseModelString(models.plannerModel) : null;

          if (parsedPlanner && isProviderUsable(parsedPlanner.providerID, readOpencodeConfig())) {
            (output as any).model = { providerID: parsedPlanner.providerID, modelID: parsedPlanner.modelID };
            log(`Escalation model mutation (planning variant): ${parsedPlanner.providerID}/${parsedPlanner.modelID}`);
          } else {
            log(`Escalation fallback: planner model not usable, keeping current model.`);
          }

          output.system.push(
            `[JEV ESCALATION DIRECTIVE]\n` +
            `The previous executor model failed repeatedly inside this loop. You are the ESCALATED PLANNER model.\n` +
            `Original task: ${ctxS.originalRequest || "(unknown — recover from context)"}\n` +
            `Failures detected: ${ctxS.failureCount} consecutive tool failures.\n` +
            `Instruction: Reason step-by-step about the root cause, design the architectural solution, ` +
            `then execute it with minimal, surgical changes. Resolve the blocker and finish the task.`
          );
          log("Directive pushed. ESCALATED (rescue cycle).");

          // The sentinel protocol applies during the rescue as well, so the
          // planner hands the report back to the cheap model when done.
          output.system.push(SENTINEL_DIRECTIVE);
          return;
        }

        // ---------------------------------------------------------------------
        // NORMAL: re-apply the cached routing decision (covers every intra-loop
        // cycle — the redundancy requested for chat.message + transform) and
        // inject routing + sentinel directives.
        // ---------------------------------------------------------------------
        if (ctxS.hasRouting) {
          const { domain, domainConfidence, complexityScore, targetModel, targetModelStr } = ctxS;

          const complexityLabel =
            complexityScore < TRIVIAL_THRESHOLD
              ? "TRIVIAL — prefer fast, direct actions; avoid over-engineering"
              : complexityScore > COMPLEX_THRESHOLD
              ? "COMPLEX — reason carefully step-by-step before acting"
              : "STANDARD — focused, efficient solution";

          output.system.push(
            `[JEV ROUTING DIRECTIVE]\n` +
            `Tool Domain : ${domain} (confidence: ${(domainConfidence * 100).toFixed(0)}%)\n` +
            `Complexity  : ${complexityLabel} (score: ${complexityScore.toFixed(2)})\n` +
            `Model Target: ${targetModel.toUpperCase()} (${targetModelStr})\n` +
            `Instruction : Prioritize the "${domain}" category for your next action. ` +
            `Adjust reasoning depth to match the complexity level above.`
          );

          // Belt-and-suspenders model mutation (chat.message is the primary
          // vector; this re-application covers intra-loop LLM calls).
          if (targetModel !== "core") {
            const parsed = parseModelString(targetModelStr);
            if (parsed && isProviderUsable(parsed.providerID, readOpencodeConfig())) {
              (output as any).model = { providerID: parsed.providerID, modelID: parsed.modelID };
            }
          }

          log(`Directive pushed. Domain: ${domain}, Score: ${complexityScore.toFixed(2)}, Model: ${targetModel}`);
        } else {
          log("No cached routing decision — chat.message may have bypassed.");
        }

        // Sentinel completion protocol — injected on every non-wrap-up cycle
        // so it survives context drift and mid-session compaction.
        output.system.push(SENTINEL_DIRECTIVE);
      } catch (err) {
        log(`system.transform error: ${(err as Error).message}`);
      }
    },
  };
});
