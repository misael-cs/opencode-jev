import fs from "fs";
import os from "os";
import path from "path";
import { parse } from "jsonc-parser";
import { buildDynamicCriteria } from "./catalog.js";

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

const CONFIG_DIR = getOpencodeConfigDir();
const JEV_DEBUG_LOG = path.join(CONFIG_DIR, "jev_debug.log");
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
// Resolve OpenRouter API key
// Priority: env var → opencode.jsonc provider.openrouter.options.apiKey
// ---------------------------------------------------------------------------

function resolveApiKey(): string | undefined {
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
// JEV API call — OpenRouter /alpha/decisions
// ---------------------------------------------------------------------------

interface JevAnswer {
  choice: string;
  confidence: number;
}

interface JevAnswers {
  next_tool_domain?: JevAnswer;
  task_complexity?: JevAnswer;
}

interface JevResponse {
  answers: JevAnswers;
}

async function queryJev(
  apiKey: string,
  contextString: string,
  mcpConfig: Record<string, unknown> | undefined
): Promise<JevAnswers | null> {
  const MAX_RETRIES = 3;
  const criteria = buildDynamicCriteria(mcpConfig);

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
              instructions: "What is the domain of the next tool to be used based on the user context?",
              criteria,
            },
            task_complexity: {
              type: "choice",
              instructions: "Rate the cognitive complexity, reasoning depth, and risk of the task requested by the user.",
              criteria: {
                TRIVIAL: "Simple text formatting, boilerplate generation, single-file reading, bash execution of standard commands (ls, npm start), answering basic questions, or summarizing.",
                STANDARD: "Standard software engineering tasks, writing new components based on scope, refactoring local logic, or connecting known APIs.",
                COMPLEX: "Deep algorithmic debugging, complex architecture design, race condition investigation, cascading failures across multiple files, or a task that has failed repeatedly."
              }
            }
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
      if (data?.answers) {
        return data.answers;
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

        const systemPrompt = input.system ?? "";
        if (!systemPrompt.includes("[JEV_ORCHESTRATOR_ENABLED]")) {
          log("Bypass: active agent is not Jev (missing [JEV_ORCHESTRATOR_ENABLED] in system prompt).");
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

        // Read config from opencode.jsonc
        let mcpConfig: Record<string, unknown> | undefined = undefined;
        let smallModel = "";
        let plannerModel = "";
        try {
          if (fs.existsSync(OPENCODE_JSONC)) {
            const raw = fs.readFileSync(OPENCODE_JSONC, "utf8");
            const config = parse(raw) as Record<string, unknown>;
            mcpConfig = config?.mcp as Record<string, unknown> | undefined;
            smallModel = (config?.small_model as string) || "";
            plannerModel = (config?.agent as any)?.plan?.model || "";
          }
        } catch (e) {
          log(`Error reading opencode config: ${(e as Error).message}`);
        }

        const answers = await queryJev(apiKey, contextString, mcpConfig);
        if (!answers || !answers.next_tool_domain) return;

        const domainAns = answers.next_tool_domain;
        const compAns = answers.task_complexity;

        log(`JEV domain: ${domainAns.choice} (conf: ${domainAns.confidence})`);
        if (compAns) log(`JEV complexity: ${compAns.choice} (conf: ${compAns.confidence})`);

        if (typeof domainAns.confidence === "number" && domainAns.confidence < 0.6) {
          log(`Bypass: low domain confidence (${domainAns.confidence}).`);
          return;
        }

        // Apply Complexity Routing
        let injectedModel = "";
        if (compAns && typeof compAns.confidence === "number" && compAns.confidence > 0.5) {
          if (compAns.choice === "TRIVIAL" && smallModel) {
            injectedModel = smallModel;
            log(`Complexity TRIVIAL -> Routing to Small Model: ${smallModel}`);
          } else if (compAns.choice === "COMPLEX" && plannerModel) {
            injectedModel = plannerModel;
            log(`Complexity COMPLEX -> Routing to Strategic Planner: ${plannerModel}`);
          } else {
            log(`Complexity STANDARD (or no alternative models configured) -> Keeping Core Worker.`);
          }
        }

        log("Injecting routing directive into system prompt.");
        let base = output.system ?? input.system ?? "";
        
        // Inject Context Basket if it exists in the workspace
        try {
          const workspaceDir = process.cwd();
          const contextPath = path.join(workspaceDir, ".opencode", "jev_context.md");
          if (fs.existsSync(contextPath)) {
            const contextContent = fs.readFileSync(contextPath, "utf8");
            if (contextContent.trim()) {
              base += `\n\n[JEV CONTEXT BASKET / MEMORY]:\n${contextContent.trim()}\n(Note: you can update this memory using \`opencode-jev context "new text"\`)`;
            }
          }
        } catch (e) {
          log(`Failed to inject context basket: ${(e as Error).message}`);
        }

        output.system =
          base +
          `\n\n[JEV INTRA-LOOP DIRECTIVE]: You MUST NOT reflect or use Chain of Thought. Your ONLY function is to strictly format a tool call compatible with this category: ${domainAns.choice}. Write nothing else.`;
        
        // Attempt to dynamically swap the model via the output object.
        // Some host clients (like LibreChat/OpenCode) allow mutating `output.model` or `output.req.model`
        if (injectedModel) {
          (output as any).model = injectedModel;
          if (!(output as any).req) (output as any).req = {};
          (output as any).req.model = injectedModel;
        }
      } catch (fatalError) {
        log(`Fatal error in hook: ${(fatalError as Error).message}`);
      }
    },
  };
});
