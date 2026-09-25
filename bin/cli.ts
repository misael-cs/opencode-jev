#!/usr/bin/env node
import fs from "fs";
import os from "os";
import path from "path";
import readline from "readline";
import { fileURLToPath } from "url";
import { parse, modify, applyEdits, ModificationOptions } from "jsonc-parser";

// ---------------------------------------------------------------------------
// Cross-platform path resolution
// ---------------------------------------------------------------------------

function getOpencodeConfigDir(): string {
  if (process.platform === "win32") {
    return path.join(os.homedir(), "AppData", "Roaming", "opencode");
  }
  const xdg = process.env.XDG_CONFIG_HOME;
  return xdg
    ? path.join(xdg, "opencode")
    : path.join(os.homedir(), ".config", "opencode");
}

function getOpencodeAgentDir(): string {
  return path.join(getOpencodeConfigDir(), "agent");
}

// ---------------------------------------------------------------------------
// JSONC helpers
// ---------------------------------------------------------------------------

function readJsonc(filePath: string): Record<string, unknown> {
  const raw = fs.readFileSync(filePath, "utf8");
  return parse(raw) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Prompt helper
// ---------------------------------------------------------------------------

function prompt(question: string, hidden = false): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    if (hidden) {
      // Mask input for API keys
      process.stdout.write(question);
      let answer = "";
      process.stdin.setRawMode?.(true);
      process.stdin.resume();
      process.stdin.setEncoding("utf8");

      const onData = (char: string) => {
        if (char === "\n" || char === "\r" || char === "\u0003") {
          process.stdin.setRawMode?.(false);
          process.stdin.pause();
          process.stdin.removeListener("data", onData);
          process.stdout.write("\n");
          rl.close();
          resolve(answer);
        } else if (char === "\u007f" || char === "\b") {
          answer = answer.slice(0, -1);
        } else {
          answer += char;
        }
      };
      process.stdin.on("data", onData);
    } else {
      rl.question(question, (answer) => {
        rl.close();
        resolve(answer);
      });
    }
  });
}

// ---------------------------------------------------------------------------
// install
// ---------------------------------------------------------------------------

async function install(): Promise<void> {
  const configDir = getOpencodeConfigDir();
  const configPath = path.join(configDir, "opencode.jsonc");
  const agentDir = getOpencodeAgentDir();

  console.log(`\nJEV Orchestrator — Installer`);
  console.log(`Config dir: ${configDir}\n`);

  // 1. Verify opencode.jsonc exists
  if (!fs.existsSync(configPath)) {
    console.error(
      `opencode.jsonc not found at ${configPath}.\nMake sure OpenCode is installed and has been run at least once.`
    );
    process.exit(1);
  }

  // 2. Patch plugin array
  const configText = fs.readFileSync(configPath, "utf8");
  const config = parse(configText) || {};
  let currentConfigText = configText;
  const formattingOptions: ModificationOptions = { formattingOptions: { insertSpaces: true, tabSize: 2 } };

  const pluginEntry = "opencode-jev";
  let pluginArray = (config.plugin as string[] | undefined) ?? [];
  if (!Array.isArray(pluginArray)) pluginArray = [pluginArray as string];

  if (pluginArray.includes(pluginEntry)) {
    console.log(`[✓] Plugin entry already present in opencode.jsonc.`);
  } else {
    pluginArray.push(pluginEntry);
    currentConfigText = applyEdits(currentConfigText, modify(currentConfigText, ["plugin"], pluginArray, formattingOptions));
    console.log(`[+] Added "${pluginEntry}" to plugin array.`);
  }

  // 3. Prompt for OpenRouter API key
  const existingKey = (
    (config.provider as Record<string, unknown> | undefined)
      ?.openrouter as Record<string, unknown> | undefined
  )?.options as Record<string, string> | undefined;

  const hasKey =
    existingKey?.apiKey && !existingKey.apiKey.startsWith("{env:");

  let apiKey = "";
  if (hasKey) {
    const overwrite = await prompt(
      "OpenRouter API key already configured. Overwrite? [y/N]: "
    );
    if (overwrite.trim().toLowerCase() === "y") {
      apiKey = await prompt("Enter your OpenRouter API key (sk-or-v1-...): ", true);
    }
  } else {
    apiKey = await prompt("Enter your OpenRouter API key (sk-or-v1-...): ", true);
  }

  if (apiKey.trim()) {
    currentConfigText = applyEdits(currentConfigText, modify(currentConfigText, ["provider", "openrouter", "options", "apiKey"], apiKey.trim(), formattingOptions));
    console.log(`[+] OpenRouter API key saved.`);
  }

  // 4. Write config back
  fs.writeFileSync(configPath, currentConfigText, "utf8");
  console.log(`[✓] opencode.jsonc updated.`);

  // 5. Copy agent/jev.md
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const agentSrc = path.join(__dirname, "..", "agent", "jev.md");
  const agentDest = path.join(agentDir, "jev.md");

  if (!fs.existsSync(agentDir)) {
    fs.mkdirSync(agentDir, { recursive: true });
  }

  if (fs.existsSync(agentSrc)) {
    fs.copyFileSync(agentSrc, agentDest);
    console.log(`[✓] agent/jev.md installed to ${agentDest}`);
  } else {
    // Fallback: write inline if package structure differs
    fs.writeFileSync(
      agentDest,
      `---\nname: Jev\ndescription: Activates JEV intra-loop routing in background (O(1) latency).\nmode: primary\n---\n[JEV_ORCHESTRATOR_ENABLED]\nYou are the Core Worker guided by JEV. Wait for the classifier injection before invoking the exact tool.\n`,
      "utf8"
    );
    console.log(`[✓] agent/jev.md written to ${agentDest}`);
  }

  console.log(`
Installation complete.

Next steps:
  1. Restart OpenCode.
  2. Press Ctrl+O and select the "Jev" agent to enable routing.
  3. Run \`opencode-jev panel\` to manage auxiliary models.
`);
}

// ---------------------------------------------------------------------------
// uninstall
// ---------------------------------------------------------------------------

async function uninstall(): Promise<void> {
  const configDir = getOpencodeConfigDir();
  const configPath = path.join(configDir, "opencode.jsonc");
  const agentPath = path.join(getOpencodeAgentDir(), "jev.md");

  const confirm = await prompt("Remove JEV plugin from opencode.jsonc and delete agent? [y/N]: ");
  if (confirm.trim().toLowerCase() !== "y") {
    console.log("Aborted.");
    return;
  }

  if (fs.existsSync(configPath)) {
    const configText = fs.readFileSync(configPath, "utf8");
    const config = parse(configText) || {};
    let pluginArray = (config.plugin as string[] | undefined) ?? [];
    pluginArray = pluginArray.filter((p) => p !== "opencode-jev");
    const newConfigText = applyEdits(configText, modify(configText, ["plugin"], pluginArray, { formattingOptions: { insertSpaces: true, tabSize: 2 } }));
    fs.writeFileSync(configPath, newConfigText, "utf8");
    console.log(`[✓] Removed "opencode-jev" from plugin array.`);
  }

  if (fs.existsSync(agentPath)) {
    fs.unlinkSync(agentPath);
    console.log(`[✓] Deleted ${agentPath}`);
  }

  console.log("Uninstall complete. Restart OpenCode to apply.");
}

// ---------------------------------------------------------------------------
// panel
// ---------------------------------------------------------------------------

async function panel(): Promise<void> {
  const portArg = process.argv[3];
  const port = portArg ? parseInt(portArg, 10) : 3040;
  const { startPanel } = await import("../src/panel.js");
  startPanel(port);
}

// ---------------------------------------------------------------------------
// scan
// ---------------------------------------------------------------------------

async function scan(): Promise<void> {
  const question = process.argv[3];
  const targetPath = process.argv[4] || ".";

  if (!question) {
    console.error("Usage: npx opencode-jev scan \"your question\" [path]");
    process.exit(1);
  }

  const { runScan } = await import("../src/scanner.js");
  await runScan(question, targetPath);
}

// ---------------------------------------------------------------------------
// context
// ---------------------------------------------------------------------------

async function context(): Promise<void> {
  const data = process.argv[3];
  if (!data) {
    console.error("Usage: npx opencode-jev context \"Your summary here\"");
    process.exit(1);
  }

  const workspaceDir = process.cwd();
  const opencodeDir = path.join(workspaceDir, ".opencode");
  
  if (!fs.existsSync(opencodeDir)) {
    fs.mkdirSync(opencodeDir, { recursive: true });
  }

  const contextFile = path.join(opencodeDir, "jev_context.md");
  fs.writeFileSync(contextFile, data, "utf8");
  console.log("[✓] Context basket updated successfully.");
}

// ---------------------------------------------------------------------------
// help
// ---------------------------------------------------------------------------

function help(): void {
  console.log(`
opencode-jev — JEV Orchestrator for OpenCode

Usage:
  npx opencode-jev install        Install plugin and agent into OpenCode config
  npx opencode-jev uninstall      Remove plugin and agent from OpenCode config
  npx opencode-jev panel [port]   Start the web control panel (default port: 3040)
  npx opencode-jev scan "query" [path] Semantic search using JEV to classify file contents
  npx opencode-jev context "text" Updates the persistent memory basket for the LLM
  npx opencode-jev --help         Show this help

What is JEV?
  JEV (Typesafe) is a non-autoregressive System 1 classifier that routes tool
  calls at O(1) latency via OpenRouter's /alpha/decisions endpoint. When the
  "Jev" agent is active in OpenCode, this plugin intercepts each turn, asks JEV
  which tool domain to use, and injects a narrow directive into the system prompt
  — eliminating expensive Chain-of-Thought for routine tool selection.

  If JEV confidence < 60% or the API is unavailable, the hook bypasses silently
  and lets the native LLM reason freely.

Routing categories:
  FS_READ            Read/explore local files and directories
  FS_WRITE           Write or edit source code files
  OS_EXECUTION       Run shell commands, scripts, containers
  WEB_AUTOMATION     Browser control, Playwright, scraping
  KNOWLEDGE_RETRIEVAL Search Obsidian, web, documentation
  INFRA_MANAGEMENT   VPS, DNS, Hostinger, domain management
  WORKFLOW_CONTROL   TODOs, sub-agents, user prompts
  FINAL_ANSWER       Prose-only responses, no tool needed

Debug log: ~/.config/opencode/jev_debug.log (or platform equivalent)
`);
}

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------

const command = process.argv[2];

switch (command) {
  case "install":
    install().catch((e) => { console.error(e); process.exit(1); });
    break;
  case "uninstall":
    uninstall().catch((e) => { console.error(e); process.exit(1); });
    break;
  case "panel":
    panel().catch((e) => { console.error(e); process.exit(1); });
    break;
  case "scan":
    scan().catch((e) => { console.error(e); process.exit(1); });
    break;
  case "context":
    context().catch((e) => { console.error(e); process.exit(1); });
    break;
  case "--help":
  case "-h":
  case undefined:
    help();
    break;
  default:
    console.error(`Unknown command: ${command}\nRun \`opencode-jev --help\` for usage.`);
    process.exit(1);
}
