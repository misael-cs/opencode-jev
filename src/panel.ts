import fs from "fs";
import http from "http";
import os from "os";
import path from "path";
import { exec } from "child_process";
import { promisify } from "util";
import { parse, modify, applyEdits, ModificationOptions } from "jsonc-parser";

const execAsync = promisify(exec);

// ---------------------------------------------------------------------------
// Cross-platform config path (mirrors src/plugin.ts)
// ---------------------------------------------------------------------------

function getOpencodeConfigDir(): string {
  if (process.platform === "win32") {
    return path.join(os.homedir(), ".config", "opencode");
  }
  const xdg = process.env.XDG_CONFIG_HOME;
  return xdg
    ? path.join(xdg, "opencode")
    : path.join(os.homedir(), ".config", "opencode");
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ModelEntry {
  id: string;
  name: string;
  provider: string;
}

interface OpencodeConfig {
  small_model?: string;
  decisionModel?: string;
  disabled_providers?: string[];
  agent?: {
    plan?: { model?: string };
  };
  provider?: Record<
    string,
    {
      models?: Record<string, { name?: string }>;
      options?: { apiKey?: string };
    }
  >;
}

interface SavePayload {
  small_model?: string;
  planner_model?: string;
  jev_model?: string;
  openrouter_key?: string;
}

// ---------------------------------------------------------------------------
// Config I/O
// ---------------------------------------------------------------------------

async function setEnvVarOS(key: string, value: string): Promise<void> {
  try {
    if (process.platform === "win32") {
      await execAsync(`setx ${key} "${value}"`);
    } else {
      // Linux/macOS: Append or replace in ~/.bashrc and ~/.zshrc
      const bashrc = path.join(os.homedir(), ".bashrc");
      const zshrc = path.join(os.homedir(), ".zshrc");
      const exportLine = `\nexport ${key}="${value}"\n`;

      const updateRcFile = (rcPath: string) => {
        if (!fs.existsSync(rcPath)) return;
        const content = fs.readFileSync(rcPath, "utf8");
        const regex = new RegExp(`^export ${key}=.*$`, "m");
        if (regex.test(content)) {
          const newContent = content.replace(regex, `export ${key}="${value}"`);
          fs.writeFileSync(rcPath, newContent);
        } else {
          fs.appendFileSync(rcPath, exportLine);
        }
      };

      updateRcFile(bashrc);
      updateRcFile(zshrc);
    }
    console.log(`Successfully registered ${key} in OS environment.`);
  } catch (err) {
    console.error(`Failed to set OS environment variable ${key}:`, err);
  }
}

function readConfig(configPath: string): OpencodeConfig {
  try {
    const raw = fs.readFileSync(configPath, "utf8");
    return parse(raw) as OpencodeConfig || {};
  } catch (e) {
    console.error("Error reading config:", (e as Error).message);
    return {};
  }
}

async function saveConfig(configPath: string, updates: SavePayload): Promise<void> {
  const text = fs.readFileSync(configPath, "utf8");
  const parsed = parse(text);
  
  if (!parsed || typeof parsed !== 'object') {
    throw new Error("Cannot parse opencode.jsonc. Aborting save to prevent data loss.");
  }
  
  let currentText = text;
  const options: ModificationOptions = { formattingOptions: { insertSpaces: true, tabSize: 2 } };

  if (updates.small_model) {
    currentText = applyEdits(currentText, modify(currentText, ["small_model"], updates.small_model, options));
  }

  if (updates.planner_model) {
    currentText = applyEdits(currentText, modify(currentText, ["agent", "plan", "model"], updates.planner_model, options));
  }

  if (updates.jev_model) {
    currentText = applyEdits(currentText, modify(currentText, ["decisionModel"], updates.jev_model, options));
  }

  if (updates.openrouter_key?.trim()) {
    const key = updates.openrouter_key.trim();
    
    // Check if the user is passing a raw key instead of the {env:...} reference
    if (!key.startsWith("{env:")) {
      // 1. Save it to the OS environment permanently
      await setEnvVarOS("OPENROUTER_API_KEY", key);
      
      // 2. Store the environment reference in opencode.jsonc instead of plain text
      currentText = applyEdits(currentText, modify(currentText, ["provider", "openrouter", "options", "apiKey"], "{env:OPENROUTER_API_KEY}", options));
    } else {
      // It's already an env reference, just save it as is
      currentText = applyEdits(currentText, modify(currentText, ["provider", "openrouter", "options", "apiKey"], key, options));
    }
  }

  fs.writeFileSync(configPath, currentText, "utf8");
}

// ---------------------------------------------------------------------------
// Model enumeration
// ---------------------------------------------------------------------------

const BUILTIN_MODELS: ModelEntry[] = [
  { id: "opencode/ling-3.0-flash-fin-free", name: "Ling 3.0 Flash Fin Free", provider: "OpenCode Zen" },
  { id: "opencode/mimo-v2.6-flash-free", name: "MiMo-V2.6-Flash Free", provider: "OpenCode Zen" },
  { id: "opencode/muse-spark-1.2", name: "Muse Spark 1.2 Free", provider: "OpenCode Zen" },
  { id: "opencode/muse-spark-1.3", name: "Muse Spark 1.3 Free", provider: "OpenCode Zen" },
  { id: "opencode/nemotron-3-ultra-free", name: "Nemotron 3 Ultra Free", provider: "OpenCode Zen" },
  { id: "opencode/nemotron-3.5-lightning-free", name: "Nemotron 3.5 Lightning Free", provider: "OpenCode Zen" },
  { id: "opencode/space-bunny-free", name: "Space Bunny Free", provider: "OpenCode Zen" },
];

function getAvailableModels(config: OpencodeConfig): ModelEntry[] {
  const disabled = config.disabled_providers ?? [];
  const dynamic: ModelEntry[] = [];

  try {
    const globalDatPath = path.join(os.homedir(), "AppData", "Roaming", "ai.opencode.desktop", "opencode.global.dat");
    if (fs.existsSync(globalDatPath)) {
      const rawGlobal = fs.readFileSync(globalDatPath, "utf8");
      const parsedGlobal = JSON.parse(rawGlobal);
      if (parsedGlobal.model) {
        const modelState = JSON.parse(parsedGlobal.model);
        if (modelState.user && Array.isArray(modelState.user)) {
          for (const u of modelState.user) {
            if (u.visibility === "show" && !disabled.includes(u.providerID)) {
              const niceProv = u.providerID.charAt(0).toUpperCase() + u.providerID.slice(1);
              dynamic.push({
                id: `${u.providerID}/${u.modelID}`,
                name: `${u.modelID} (${niceProv})`,
                provider: niceProv,
              });
            }
          }
        }
      }
    }
  } catch (e) {
    console.error("Erro ao ler modelos do OpenCode Desktop:", e);
  }

  if (config.provider) {
    for (const [prov, provData] of Object.entries(config.provider)) {
      if (disabled.includes(prov)) continue;
      if (provData.models) {
        for (const [modId, modData] of Object.entries(provData.models)) {
          const niceProv = prov.charAt(0).toUpperCase() + prov.slice(1);
          const fullId = `${prov}/${modId}`;
          if (!dynamic.find((x) => x.id === fullId)) {
            dynamic.push({
              id: fullId,
              name: modData.name ?? modId,
              provider: niceProv,
            });
          }
        }
      }
    }
  }

  const all = [...dynamic];
  for (const m of BUILTIN_MODELS) {
    if (!all.find((x) => x.id === m.id)) all.push(m);
  }

  // Keep currently saved models even if not in list
  const currentModels = [config.small_model, config.agent?.plan?.model];
  for (const m of currentModels) {
    if (m && !all.find((x) => x.id === m || `${x.id}-Free` === m)) {
      all.push({ id: m, name: `${m} (implícito/externo)`, provider: "Outros" });
    }
  }

  return all;
}

function buildSelectOptions(models: ModelEntry[], selected?: string): string {
  const groups: Record<string, ModelEntry[]> = {};
  for (const m of models) {
    if (!groups[m.provider]) groups[m.provider] = [];
    groups[m.provider].push(m);
  }

  let html = "";
  for (const [provider, provModels] of Object.entries(groups)) {
    html += `  <optgroup label="${provider}">\n`;
    for (const m of provModels) {
      const isSelected =
        selected &&
        (m.id === selected || m.id === selected.replace(/-Free$/i, ""))
          ? "selected"
          : "";
      html += `    <option value="${m.id}" ${isSelected}>${m.name}</option>\n`;
    }
    html += `  </optgroup>\n`;
  }
  return html;
}

// ---------------------------------------------------------------------------
// HTML panel
// ---------------------------------------------------------------------------

function renderPanel(config: OpencodeConfig): string {
  const models = getAvailableModels(config);
  const currentKey = config.provider?.openrouter?.options?.apiKey ?? "";
  const safeKey =
    currentKey && !currentKey.startsWith("{env:") ? currentKey : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>JEV Orchestrator — Control Panel</title>
  <style>
    body { font-family: system-ui; background: #111; color: #eee; padding: 2rem; max-width: 700px; margin: auto; }
    label { display: block; margin-top: 1.5rem; font-weight: bold; color: #93c5fd; }
    p.desc { font-size: 0.85rem; color: #888; margin-top: 0.25rem; margin-bottom: 0.5rem; }
    select, input { width: 100%; padding: 0.75rem; background: #222; color: #fff; border: 1px solid #444; border-radius: 4px; box-sizing: border-box; }
    input[readonly] { opacity: 0.5; cursor: not-allowed; }
    button { margin-top: 2rem; padding: 1rem 2rem; background: #3b82f6; color: white; border: none; border-radius: 4px; cursor: pointer; font-weight: bold; width: 100%; font-size: 1rem; }
    button:hover { background: #2563eb; }
    .notice { background: #1e293b; border-left: 4px solid #3b82f6; padding: 1rem; margin-bottom: 2rem; font-size: 0.9rem; line-height: 1.5; }
    optgroup { color: #9ca3af; font-weight: bold; font-style: normal; }
    option { color: #fff; font-weight: normal; }
  </style>
</head>
<body>
  <h2>JEV Orchestrator — Control Panel</h2>
  <div class="notice">
    The <strong>Core Worker</strong> (primary model) is not managed here.
    Change it freely in the OpenCode TUI. Use this panel only to govern the
    auxiliary and background orchestration layers.
  </div>
  <form id="configForm">
    <label>OpenRouter API Key
      <p class="desc">Access key (sk-or-v1-...). When saved, this panel will register it directly in your OS environment variables (as OPENROUTER_API_KEY) and store only a reference ({env:OPENROUTER_API_KEY}) in opencode.jsonc to keep your key secure.</p>
      <input type="password" name="openrouter_key" value="${safeKey}" placeholder="sk-or-v1-...">
    </label>

    <label>Intra-Loop Router (Decision Model)
      <p class="desc">The deterministic classifier that governs tool routing in the background.</p>
      <input type="text" name="jev_model" value="${config.decisionModel ?? "typesafe/jev-1.13"}" readonly title="Fixed for OpenRouter/Typesafe integration.">
    </label>

    <label>Context Harvester / Scraper (Small Model)
      <p class="desc">Reads massive logs, global scans — high speed and low cost.</p>
      <select name="small_model">
        ${buildSelectOptions(models, config.small_model)}
      </select>
    </label>

    <label>Strategic Planner (Fallback Agent)
      <p class="desc">Rescue actor activated by JEV for architecture decisions or stuck loops.</p>
      <select name="planner_model">
        ${buildSelectOptions(models, config.agent?.plan?.model)}
      </select>
    </label>

    <button type="submit">Save Orchestration Config</button>
  </form>
  <script>
    document.getElementById('configForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const formData = new FormData(e.target);
      const data = Object.fromEntries(formData.entries());
      const response = await fetch('/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      });
      if (response.ok) alert('Orchestration config saved to opencode.jsonc!');
      else alert('Error saving config.');
    });
  </script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Server factory — exported so the CLI can call startPanel(port)
// ---------------------------------------------------------------------------

export function startPanel(port = 3040, configDir?: string): void {
  const resolvedConfigDir = configDir ?? getOpencodeConfigDir();
  const configPath = path.join(resolvedConfigDir, "opencode.jsonc");

  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/") {
      const config = readConfig(configPath);
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(renderPanel(config));
      return;
    }

    if (req.method === "POST" && req.url === "/save") {
      let body = "";
      req.on("data", (chunk: Buffer) => (body += chunk.toString()));
      req.on("end", async () => {
        try {
          await saveConfig(configPath, JSON.parse(body) as SavePayload);
          res.writeHead(200);
          res.end("OK");
        } catch (e) {
          res.writeHead(500);
          res.end((e as Error).message);
        }
      });
      return;
    }

    res.writeHead(404);
    res.end();
  });

  server.listen(port, () => {
    console.log(`JEV Control Panel running at http://localhost:${port}`);
    console.log("Press Ctrl+C to stop.");
  });
}
