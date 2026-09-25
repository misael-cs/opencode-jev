import fs from "fs";
import os from "os";
import path from "path";

// ---------------------------------------------------------------------------
// Cross-platform path resolution
// ---------------------------------------------------------------------------

function getOpencodeConfigDir(): string {
  if (process.platform === "win32") {
    return path.join(os.homedir(), "AppData", "Roaming", "opencode");
  }
  // Linux / macOS: XDG_CONFIG_HOME or ~/.config
  const xdg = process.env.XDG_CONFIG_HOME;
  return xdg ? path.join(xdg, "opencode") : path.join(os.homedir(), ".config", "opencode");
}

function getOpencodeLogPath(): string {
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
    return path.join(local, "opencode", "log", "opencode.log");
  }
  // Linux / macOS: XDG_DATA_HOME or ~/.local/share
  const xdgData = process.env.XDG_DATA_HOME;
  const base = xdgData ?? path.join(os.homedir(), ".local", "share");
  return path.join(base, "opencode", "log", "opencode.log");
}

const CONFIG_DIR = getOpencodeConfigDir();
const JEV_DEBUG_LOG = path.join(CONFIG_DIR, "jev_debug.log");
const OPENCODE_LOG = getOpencodeLogPath();
const OPENCODE_JSONC = path.join(CONFIG_DIR, "opencode.jsonc");

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

function log(msg: string): void {
  try {
    fs.appendFileSync(JEV_DEBUG_LOG, `${new Date().toISOString()} - ${msg}\n`);
  } catch (_) {
    // silent — never crash the hook due to logging failure
  }
}

// ---------------------------------------------------------------------------
// Config reader — strips JSONC comments before parsing
// ---------------------------------------------------------------------------

function readJsonc(filePath: string): Record<string, unknown> {
  const raw = fs.readFileSync(filePath, "utf8");
  // Remove block comments first, then line comments (skip URLs: https://)
  const clean = raw
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(?<!:)\/\/.*/g, "");
  return JSON.parse(clean) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Resolve OpenRouter API key
// Priority: env var → opencode.jsonc provider.openrouter.options.apiKey
// ---------------------------------------------------------------------------

function resolveApiKey(): string | undefined {
  const envKey = process.env.OPENROUTER_API_KEY;
  if (envKey) return envKey;

  try {
    if (fs.existsSync(OPENCODE_JSONC)) {
      const config = readJsonc(OPENCODE_JSONC);
      const provider = config.provider as Record<string, unknown> | undefined;
      const openrouter = provider?.openrouter as Record<string, unknown> | undefined;
      const options = openrouter?.options as Record<string, unknown> | undefined;
      const key = options?.apiKey as string | undefined;
      // Reject {env:...} placeholders — they weren't resolved
      if (key && !key.startsWith("{env:")) return key;
    }
  } catch (e) {
    log(`Error reading apiKey from opencode.jsonc: ${(e as Error).message}`);
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Detect whether the active OpenCode session is using the "Jev" agent
// by scanning the tail of the OpenCode log for the current sessionID.
// ---------------------------------------------------------------------------

function isJevAgentActive(sessionID: string): boolean {
  try {
    if (!fs.existsSync(OPENCODE_LOG)) return false;

    const content = fs.readFileSync(OPENCODE_LOG, "utf8");
    const lines = content.trim().split("\n");
    const scanFrom = Math.max(0, lines.length - 150);

    for (let i = lines.length - 1; i >= scanFrom; i--) {
      const line = lines[i];
      if (line.includes(`session.id=${sessionID}`) && line.includes("agent=")) {
        // Strip ANSI color codes before matching
        const clean = line.replace(/\u001b\[.*?m/g, "").toLowerCase();
        return clean.includes("agent=jev");
      }
    }
  } catch (e) {
    log(`Error reading opencode log: ${(e as Error).message}`);
  }
  return false;
}

// ---------------------------------------------------------------------------
// JEV API call — OpenRouter /alpha/decisions
// ---------------------------------------------------------------------------

interface JevAnswer {
  choice: string;
  confidence: number;
}

interface JevResponse {
  answers: {
    next_tool_domain: JevAnswer;
  };
}

async function queryJev(
  apiKey: string,
  contextString: string
): Promise<JevAnswer | null> {
  const MAX_RETRIES = 3;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000);

      const response = await fetch("https://openrouter.ai/api/alpha/decisions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "typesafe/jev-1.13",
          questions: {
            next_tool_domain: {
              type: "choice",
              instructions:
                "What is the domain of the next tool to be used based on the user context?",
              criteria: {
                FS_READ:
                  "Read code, read files, explore directories, search for files or inspect content in the local repository.",
                FS_WRITE:
                  "Write, edit, modify or create new source code files.",
                OS_EXECUTION:
                  "Run scripts (.ps1, .sh), start containers (docker), servers, or execute commands in the terminal/shell.",
                WEB_AUTOMATION:
                  "Automated web tests, browser control (Playwright), page inspection or web scraping.",
                KNOWLEDGE_RETRIEVAL:
                  "Search in Obsidian knowledge base, run Google searches, or read documentation from the internet.",
                INFRA_MANAGEMENT:
                  "Actions related to infrastructure, VPS, Hostinger servers, DNS, or managing web domains.",
                WORKFLOW_CONTROL:
                  "Create task lists (TODO), ask the user for additional information, or delegate sub-agents.",
                FINAL_ANSWER:
                  "Only respond discursively when no file or terminal action is required.",
              },
            },
          },
          state: { context: contextString },
        }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`HTTP ${response.status}: ${errText}`);
      }

      const data = (await response.json()) as JevResponse;
      if (data?.answers?.next_tool_domain) {
        return data.answers.next_tool_domain;
      }
      throw new Error("Malformed response from OpenRouter decisions API");
    } catch (err) {
      log(`JEV attempt ${attempt + 1} failed: ${(err as Error).message}`);
      if (attempt < MAX_RETRIES - 1) {
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }

  log("Bypass: max retries reached.");
  return null;
}

// ---------------------------------------------------------------------------
// Plugin export — consumed by OpenCode via `plugin` array in opencode.jsonc
// ---------------------------------------------------------------------------

export default (async ({ client, project }: { client: unknown; project: unknown }) => {
  return {
    "experimental.chat.system.transform": async (
      input: {
        sessionID?: string;
        messages?: Array<{ content: string | Array<{ type: string; text: string }> }>;
        system?: string;
      },
      output: { system?: string }
    ) => {
      try {
        log("-----------------------------------------");
        log("Hook fired.");

        if (!input.sessionID) {
          log("No sessionID. Bypass.");
          return;
        }

        // Small delay to ensure OpenCode has flushed the session/agent info to disk
        await new Promise((r) => setTimeout(r, 250));

        if (!isJevAgentActive(input.sessionID)) {
          log("Bypass: active agent is not Jev.");
          return;
        }

        log("JEV IS ENABLED. Starting processing...");

        // Extract last user message as context for JEV
        const messages = input.messages ?? [];
        let contextString = "Context unavailable via system.transform hook.";

        if (messages.length > 0) {
          const lastMsg = messages[messages.length - 1];
          let content = lastMsg?.content ?? "";
          if (Array.isArray(content)) {
            const textBlocks = content.filter((b) => b.type === "text");
            content = textBlocks.length > 0
              ? textBlocks.map((b) => b.text).join(" ")
              : JSON.stringify(content);
          }
          contextString = typeof content === "string" ? content : JSON.stringify(content);
          log(`Context sent to JEV: ${contextString.substring(0, 150)}`);
        }

        const apiKey = resolveApiKey();
        if (!apiKey) {
          log("Bypass: OPENROUTER_API_KEY not found (neither env var nor opencode.jsonc).");
          return;
        }

        const answer = await queryJev(apiKey, contextString);
        if (!answer) return;

        log(`JEV answered: ${answer.choice} (confidence: ${answer.confidence})`);

        if (typeof answer.confidence === "number" && answer.confidence < 0.6) {
          log(`Bypass: low confidence (${answer.confidence}).`);
          return;
        }

        log("Injecting routing directive into system prompt.");
        const base = output.system ?? input.system ?? "";
        output.system =
          base +
          `\n\n[JEV INTRA-LOOP DIRECTIVE]: You MUST NOT reflect or use Chain of Thought. Your ONLY function is to strictly format a tool call compatible with this category: ${answer.choice}. Write nothing else.`;
      } catch (fatalError) {
        log(`Fatal error in hook: ${(fatalError as Error).message}`);
      }
    },
  };
});
