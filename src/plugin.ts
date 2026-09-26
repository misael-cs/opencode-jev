import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { buildDynamicCriteria } from "./catalog.js";
import {
  CONFIG_DIR,
  log,
  getLocalTimestamp,
  resolveApiKey,
  readOpencodeConfig,
  parseModelString,
} from "./utils.js";

// ---------------------------------------------------------------------------
// TypeSafe/JEV answer types
// Using the correct primitives per docs:
//   choice  → fixed-set routing (tool domain)
//   score   → ordered rubric (complexity)
//   noul    → probability of yes/no (guardrail checks, failure detection)
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
// Per-session JEV decision cache
// Populated by chat.message → consumed by experimental.chat.system.transform.
// Both hooks fire sequentially per turn.
// ---------------------------------------------------------------------------

interface JevDecision {
  domain: string;
  domainConfidence: number;
  complexityScore: number;       // 0.0 = trivial → 1.0 = standard → 2.0 = complex
  complexityConfidence: number;
  targetModel: "small" | "core" | "planner";
  targetModelStr: string;
  timestamp: number;
}

const sessionDecisionCache = new Map<string, JevDecision>();

// ---------------------------------------------------------------------------
// Per-session guardrail state
// Tracks consecutive tool failures for reactive mid-loop escalation.
// This is the canonical "Harness Engineering" pattern from TypeSafe docs:
// "classify agent traces at lightspeed" + "detect errors in real time"
// ---------------------------------------------------------------------------

interface SessionGuardrailState {
  failureCount: number;           // consecutive failed tool calls
  lastFailureTimestamp: number;
  forceEscalate: boolean;         // true → override next turn to planner
  blockedToolCalls: number;       // total guardrail blocks this session
}

const sessionGuardrailState = new Map<string, SessionGuardrailState>();

const ESCALATION_FAILURE_THRESHOLD = 2;  // failures before forcing planner
const FAILURE_WINDOW_MS = 5 * 60 * 1000; // reset counter after 5 min idle

function getGuardrailState(sessionID: string): SessionGuardrailState {
  if (!sessionGuardrailState.has(sessionID)) {
    sessionGuardrailState.set(sessionID, {
      failureCount: 0,
      lastFailureTimestamp: 0,
      forceEscalate: false,
      blockedToolCalls: 0,
    });
  }
  return sessionGuardrailState.get(sessionID)!;
}

function pruneCache(): void {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [k, v] of sessionDecisionCache) {
    if (v.timestamp < cutoff) sessionDecisionCache.delete(k);
  }
  // Also prune sessions with old failures
  for (const [k, v] of sessionGuardrailState) {
    if (v.lastFailureTimestamp > 0 && Date.now() - v.lastFailureTimestamp > FAILURE_WINDOW_MS) {
      v.failureCount = 0;
      v.forceEscalate = false;
    }
  }
}

// ---------------------------------------------------------------------------
// Complexity routing thresholds
// score: 0 (trivial) → 1 (standard) → 2 (complex)
// ---------------------------------------------------------------------------

const TRIVIAL_THRESHOLD = 0.6;
const COMPLEX_THRESHOLD = 1.5;

function resolveTargetModel(
  score: number,
  confidence: number,
  smallModel: string,
  plannerModel: string,
  coreModel: string
): { target: "small" | "core" | "planner"; modelStr: string } {
  if (confidence < 0.35) return { target: "core", modelStr: coreModel };
  if (score < TRIVIAL_THRESHOLD && smallModel) return { target: "small", modelStr: smallModel };
  if (score > COMPLEX_THRESHOLD && plannerModel) return { target: "planner", modelStr: plannerModel };
  return { target: "core", modelStr: coreModel };
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
// Plugin export
// ---------------------------------------------------------------------------

export default (async (_ctx: unknown) => {
  // Autostart web dashboard silently
  try {
    const dashboardPath = path.join(__dirname, "dashboard.js");
    if (fs.existsSync(dashboardPath)) {
      const p = spawn(process.execPath, [dashboardPath], { detached: true, stdio: "ignore" });
      p.unref();
    }
  } catch (e) {
    log(`Dashboard autostart failed: ${(e as Error).message}`);
  }

  return {
    // -------------------------------------------------------------------------
    // Hook 1: chat.message
    // Fires when the user message arrives, BEFORE the LLM processes it.
    // Primary model swap vector: override output.message.model.
    // Also checks if reactive escalation is active (from prior tool failures).
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
        log(`--- chat.message | session: ${input.sessionID} ---`);

        const jevStatePath = path.join(CONFIG_DIR, "jev_state.json");
        let jevState = {
          enabled: false,
          confidenceThreshold: 0.6,
          blockDangerous: false,   // opt-in: block dangerous tool calls
          stats: { totalCalls: 0, models: {} as Record<string, number> },
        };
        try {
          if (fs.existsSync(jevStatePath)) {
            jevState = { ...jevState, ...JSON.parse(fs.readFileSync(jevStatePath, "utf8")) };
          }
        } catch (_) {}

        if (!jevState.enabled) { log("Bypass: JEV disabled."); return; }

        const apiKey = resolveApiKey();
        if (!apiKey) { log("Bypass: no API key."); return; }

        // Extract user message text from output.parts
        const textParts = output.parts
          .filter((p) => p.type === "text" && typeof p.text === "string")
          .map((p) => p.text as string);

        if (!textParts.length) { log("Bypass: no text parts."); return; }
        const messageText = textParts.join("\n").trim();
        if (!messageText) { log("Bypass: empty message."); return; }
        log(`Message (preview): ${messageText.substring(0, 100)}`);

        const config = readOpencodeConfig();
        const currentModelObj = input.model ?? output.message.model ?? { providerID: "unknown", modelID: "unknown" };
        const currentModelStr = `${currentModelObj.providerID}/${currentModelObj.modelID}`;
        const smallModel = (config?.small_model as string) || "";
        const plannerModel = (config?.agent as any)?.plan?.model || "";
        const mcpConfig = config?.mcp as Record<string, unknown> | undefined;
        const availableTools = Object.keys(buildDynamicCriteria(mcpConfig));

        // Call JEV for routing + complexity
        const answers = await queryJevRouting(
          apiKey, messageText, input.sessionID, currentModelStr, availableTools
        );

        if (!answers?.next_tool_domain) { log("JEV returned no answers."); return; }

        const domainAns = answers.next_tool_domain as JevChoiceAnswer;
        const compAns = answers.task_complexity as JevScoreAnswer | undefined;

        const threshold = jevState.confidenceThreshold ?? 0.6;
        let complexityScore = compAns?.score ?? 1.0;
        const complexityConf = compAns?.confidence ?? 0;

        // --- Reactive escalation override ---
        // If prior tool failures reached threshold, force COMPLEX regardless of JEV score.
        // This is the canonical mid-loop escalation pattern from TypeSafe docs.
        const guardrail = getGuardrailState(input.sessionID);
        if (guardrail.forceEscalate) {
          complexityScore = 2.0;
          guardrail.forceEscalate = false; // consume the escalation flag
          log(`REACTIVE ESCALATION: Forcing complexity=2.0 (planner) after ${guardrail.failureCount} failures.`);
          guardrail.failureCount = 0;
        }

        log(`Domain: ${domainAns.choice} (conf: ${domainAns.confidence.toFixed(2)})`);
        log(`Complexity: score=${complexityScore.toFixed(2)} conf=${complexityConf.toFixed(2)}`);

        const routing = resolveTargetModel(
          complexityScore, complexityConf, smallModel, plannerModel, currentModelStr
        );
        log(`Routing → ${routing.target.toUpperCase()} (${routing.modelStr})`);

        // Cache decision for system.transform
        sessionDecisionCache.set(input.sessionID, {
          domain: domainAns.choice,
          domainConfidence: domainAns.confidence,
          complexityScore,
          complexityConfidence: complexityConf,
          targetModel: routing.target,
          targetModelStr: routing.modelStr,
          timestamp: Date.now(),
        });

        // Update stats
        try {
          jevState.stats.totalCalls = (jevState.stats.totalCalls || 0) + 1;
          jevState.stats.models[routing.target] = (jevState.stats.models[routing.target] || 0) + 1;
          fs.writeFileSync(jevStatePath, JSON.stringify(jevState, null, 2));
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
        const jevStatePath = path.join(CONFIG_DIR, "jev_state.json");
        let jevState = { enabled: false, blockDangerous: false };
        try {
          if (fs.existsSync(jevStatePath)) {
            jevState = { ...jevState, ...JSON.parse(fs.readFileSync(jevStatePath, "utf8")) };
          }
        } catch (_) {}

        if (!jevState.enabled) return;

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
          const guardrail = getGuardrailState(input.sessionID);
          guardrail.blockedToolCalls++;

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
    // An MCP tool returning an API error, a failed VPS operation, or a
    // rejected DNS change all count as failures and feed the escalation loop.
    // Consecutive failures → forceEscalate flag → next turn routes to Planner.
    //
    // Exception: local content tools (read/glob/grep/list) return file content,
    // not execution results — "output" may contain the word "error" as data.
    // Their actual failures are thrown by the tool itself, so we skip them.
    // -------------------------------------------------------------------------
    "tool.execute.after": async (
      input: { tool: string; sessionID: string; callID: string; args: unknown },
      output: { title: string; output: string; metadata: unknown }
    ) => {
      try {
        // Local content tools: output is data, not an execution result.
        // (MCP read tools are NOT skipped — their API errors matter.)
        const LOCAL_CONTENT_TOOLS = new Set(["read", "glob", "grep", "list", "todoread"]);
        if (LOCAL_CONTENT_TOOLS.has(input.tool)) return;

        const jevStatePath = path.join(CONFIG_DIR, "jev_state.json");
        let jevEnabled = false;
        try {
          if (fs.existsSync(jevStatePath)) {
            jevEnabled = JSON.parse(fs.readFileSync(jevStatePath, "utf8")).enabled === true;
          }
        } catch (_) {}

        if (!jevEnabled) return;

        const apiKey = resolveApiKey();
        if (!apiKey) return;

        // Skip very short outputs (usually successful with no output)
        const toolOutput = (output.output ?? "").trim();
        if (toolOutput.length < 10) return;

        // Polyvalent: monitor every tool's output, regardless of origin.
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

        if (isFailure > 0.78) {
          const guardrail = getGuardrailState(input.sessionID);
          guardrail.failureCount++;
          guardrail.lastFailureTimestamp = Date.now();

          log(`Session ${input.sessionID} failure count: ${guardrail.failureCount}/${ESCALATION_FAILURE_THRESHOLD}`);

          try {
            fs.appendFileSync(
              path.join(CONFIG_DIR, "jev_classifications.jsonl"),
              JSON.stringify({
                timestamp: getLocalTimestamp(),
                type: "failure_detect",
                sessionID: input.sessionID,
                tool: input.tool,
                isFailure,
                failureCount: guardrail.failureCount,
              }) + "\n"
            );
          } catch (_) {}

          if (guardrail.failureCount >= ESCALATION_FAILURE_THRESHOLD) {
            // Set the reactive escalation flag.
            // On the next chat.message hook, this forces complexityScore=2.0 → Planner model.
            guardrail.forceEscalate = true;
            log(
              `REACTIVE ESCALATION TRIGGERED: ${guardrail.failureCount} consecutive failures → ` +
              `next turn will force Planner model.`
            );
          }
        } else if (isFailure < 0.30) {
          // Successful tool call — gradually reset failure counter
          const guardrail = getGuardrailState(input.sessionID);
          if (guardrail.failureCount > 0) {
            guardrail.failureCount = Math.max(0, guardrail.failureCount - 1);
            log(`Failure counter decremented → ${guardrail.failureCount} (successful tool call)`);
          }
        }
      } catch (err) {
        log(`tool.execute.after error: ${(err as Error).message}`);
      }
    },

    // -------------------------------------------------------------------------
    // Hook 4: experimental.chat.system.transform
    // Fires just before the LLM call.
    // CORRECT output format: { system: string[] } — push segments, never replace.
    // Reads cached JEV decision from chat.message.
    // -------------------------------------------------------------------------
    "experimental.chat.system.transform": async (
      input: { sessionID?: string; model: unknown },
      output: { system: string[] }
    ) => {
      try {
        log(`--- system.transform | session: ${input.sessionID} ---`);

        if (!input.sessionID) return;

        let jevEnabled = false;
        try {
          const jevStatePath = path.join(CONFIG_DIR, "jev_state.json");
          if (fs.existsSync(jevStatePath)) {
            jevEnabled = JSON.parse(fs.readFileSync(jevStatePath, "utf8")).enabled === true;
          }
        } catch (_) {}

        if (!jevEnabled) return;

        // Inject persistent context basket (anti-amnesia memory)
        try {
          const contextPath = path.join(process.cwd(), ".opencode", "jev_context.md");
          if (fs.existsSync(contextPath)) {
            const ctx = fs.readFileSync(contextPath, "utf8").trim();
            if (ctx) {
              output.system.push(
                `[JEV CONTEXT BASKET / MEMORY]\n${ctx}\n(Update: \`opencode-jev context "text"\`)`
              );
              log("Context basket injected.");
            }
          }
        } catch (_) {}

        // Read cached routing decision from chat.message hook
        const decision = sessionDecisionCache.get(input.sessionID);
        if (!decision) {
          log("No cached decision — chat.message may have bypassed.");
          return;
        }

        const { domain, domainConfidence, complexityScore, targetModel, targetModelStr } = decision;

        const complexityLabel =
          complexityScore < TRIVIAL_THRESHOLD
            ? "TRIVIAL — prefer fast, direct actions; avoid over-engineering"
            : complexityScore > COMPLEX_THRESHOLD
            ? "COMPLEX — reason carefully step-by-step before acting"
            : "STANDARD — focused, efficient solution";

        // Push routing directive to system array (correct API: push, never replace)
        output.system.push(
          `[JEV ROUTING DIRECTIVE]\n` +
          `Tool Domain : ${domain} (confidence: ${(domainConfidence * 100).toFixed(0)}%)\n` +
          `Complexity  : ${complexityLabel} (score: ${complexityScore.toFixed(2)})\n` +
          `Model Target: ${targetModel.toUpperCase()} (${targetModelStr})\n` +
          `Instruction : Prioritize the "${domain}" category for your next action. ` +
          `Adjust reasoning depth to match the complexity level above.`
        );

        log(`Directive pushed. Domain: ${domain}, Score: ${complexityScore.toFixed(2)}, Model: ${targetModel}`);

        // Belt-and-suspenders backup model mutation
        if (targetModel !== "core") {
          const parsed = parseModelString(targetModelStr);
          if (parsed) {
            (output as any).model = { providerID: parsed.providerID, modelID: parsed.modelID };
            log(`Backup model mutation: ${parsed.providerID}/${parsed.modelID}`);
          }
        }
      } catch (err) {
        log(`system.transform error: ${(err as Error).message}`);
      }
    },
  };
});
