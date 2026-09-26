import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';
import { parse, modify, applyEdits, ModificationOptions } from 'jsonc-parser';
import SysTrayModule from 'systray2';

const execAsync = promisify(exec);
const moduleDir = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Cross-platform setup
// ---------------------------------------------------------------------------
const port = 19999;

function getOpencodeConfigDir(): string {
  if (process.platform === "win32") {
    return path.join(os.homedir(), ".config", "opencode");
  }
  const xdg = process.env.XDG_CONFIG_HOME;
  return xdg
    ? path.join(xdg, "opencode")
    : path.join(os.homedir(), ".config", "opencode");
}

const configDir = getOpencodeConfigDir();
const stateFile = path.join(configDir, 'jev_state.json');
const logFile = path.join(configDir, 'jev_debug.log');
const classLogFile = path.join(configDir, 'jev_classifications.jsonl');
const configPath = path.join(configDir, 'opencode.jsonc');

// ---------------------------------------------------------------------------
// Liveness state (kept for /api/heartbeat; server persists via system tray)
// ---------------------------------------------------------------------------
let hasConnected = false;
let lastHeartbeat = Date.now();

const openBrowser = (url: string) => {
    const platform = os.platform();
    if (platform === 'win32') exec(`start "" "${url}"`);
    else if (platform === 'darwin') exec(`open "${url}"`);
    else exec(`xdg-open "${url}"`);
};

// ---------------------------------------------------------------------------
// JEV State Management (jev_state.json)
// ---------------------------------------------------------------------------
function getJevState() {
    try {
        if (fs.existsSync(stateFile)) return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    } catch(e) {}
    return { enabled: false, confidenceThreshold: 0.6, blockDangerous: false, stats: { totalCalls: 0, models: {} } };
}

function saveJevState(state: any) {
    if(!fs.existsSync(configDir)) fs.mkdirSync(configDir, {recursive: true});
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
}

// ---------------------------------------------------------------------------
// OpenCode Config Management (opencode.jsonc) - Ported from panel.ts
// ---------------------------------------------------------------------------
interface ModelEntry { id: string; name: string; provider: string; }

const BUILTIN_MODELS: ModelEntry[] = [
  { id: "opencode/ling-3.0-flash-fin-free", name: "Ling 3.0 Flash Fin Free", provider: "OpenCode Zen" },
  { id: "opencode/mimo-v2.6-flash-free", name: "MiMo-V2.6-Flash Free", provider: "OpenCode Zen" },
  { id: "opencode/muse-spark-1.2", name: "Muse Spark 1.2 Free", provider: "OpenCode Zen" },
  { id: "opencode/muse-spark-1.3", name: "Muse Spark 1.3 Free", provider: "OpenCode Zen" },
  { id: "opencode/nemotron-3-ultra-free", name: "Nemotron 3 Ultra Free", provider: "OpenCode Zen" },
  { id: "opencode/nemotron-3.5-lightning-free", name: "Nemotron 3.5 Lightning Free", provider: "OpenCode Zen" },
  { id: "opencode/space-bunny-free", name: "Space Bunny Free", provider: "OpenCode Zen" },
];

function readConfig(): any {
  try {
    const raw = fs.readFileSync(configPath, "utf8");
    return parse(raw) || {};
  } catch (e) {
    return {};
  }
}

function getAvailableModels(config: any): ModelEntry[] {
  const disabled = config.disabled_providers ?? [];
  const dynamic: ModelEntry[] = [];

  // 1. Ler modelos ativos/visíveis do OpenCode Desktop UI (opencode.global.dat)
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

  // 2. Modelo estático / customizado configurado no opencode.jsonc
  if (config.provider) {
    for (const [prov, provData] of Object.entries(config.provider)) {
      if (disabled.includes(prov)) continue;
      const pd = provData as any;
      if (pd.models) {
        for (const [modId, modData] of Object.entries(pd.models)) {
          const niceProv = prov.charAt(0).toUpperCase() + prov.slice(1);
          const fullId = `${prov}/${modId}`;
          if (!dynamic.find((x) => x.id === fullId)) {
            dynamic.push({
              id: fullId,
              name: (modData as any).name ?? modId,
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

  const currentModels = [config.small_model, config.agent?.plan?.model];
  for (const m of currentModels) {
    if (m && !all.find((x) => x.id === m || `${x.id}-Free` === m)) {
      all.push({ id: m, name: `${m} (implícito/externo)`, provider: "Outros" });
    }
  }

  return all;
}

async function setEnvVarOS(key: string, value: string): Promise<void> {
  try {
    if (process.platform === "win32") {
      await execAsync(`setx ${key} "${value}"`);
    } else {
      const bashrc = path.join(os.homedir(), ".bashrc");
      const zshrc = path.join(os.homedir(), ".zshrc");
      const exportLine = `\nexport ${key}="${value}"\n`;

      const updateRcFile = (rcPath: string) => {
        if (!fs.existsSync(rcPath)) return;
        const content = fs.readFileSync(rcPath, "utf8");
        const regex = new RegExp(`^export ${key}=.*$`, "m");
        if (regex.test(content)) {
          fs.writeFileSync(rcPath, content.replace(regex, `export ${key}="${value}"`));
        } else {
          fs.appendFileSync(rcPath, exportLine);
        }
      };

      updateRcFile(bashrc);
      updateRcFile(zshrc);
    }
  } catch (err) {
    console.error(`Failed to set OS environment variable ${key}:`, err);
  }
}

async function saveOpencodeConfig(updates: any): Promise<void> {
  const text = fs.readFileSync(configPath, "utf8");
  let currentText = text;
  const options: ModificationOptions = { formattingOptions: { insertSpaces: true, tabSize: 2 } };

  if (updates.small_model !== undefined) {
    currentText = applyEdits(currentText, modify(currentText, ["small_model"], updates.small_model, options));
  }
  if (updates.planner_model !== undefined) {
    currentText = applyEdits(currentText, modify(currentText, ["agent", "plan", "model"], updates.planner_model, options));
  }
  if (updates.jev_model !== undefined) {
    currentText = applyEdits(currentText, modify(currentText, ["decisionModel"], updates.jev_model, options));
  }

  if (updates.openrouter_key?.trim()) {
    const key = updates.openrouter_key.trim();
    if (!key.startsWith("{env:")) {
      await setEnvVarOS("OPENROUTER_API_KEY", key);
      currentText = applyEdits(currentText, modify(currentText, ["provider", "openrouter", "options", "apiKey"], "{env:OPENROUTER_API_KEY}", options));
    } else {
      currentText = applyEdits(currentText, modify(currentText, ["provider", "openrouter", "options", "apiKey"], key, options));
    }
  }

  fs.writeFileSync(configPath, currentText, "utf8");
}

// ---------------------------------------------------------------------------
// HTML UI
// ---------------------------------------------------------------------------
const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>JEV Control Center</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <style>
        ::-webkit-scrollbar { width: 8px; }
        ::-webkit-scrollbar-track { background: #111827; }
        ::-webkit-scrollbar-thumb { background: #374151; border-radius: 4px; }
        ::-webkit-scrollbar-thumb:hover { background: #4b5563; }
        [x-cloak] { display: none !important; }
    </style>
    <script defer src="https://cdn.jsdelivr.net/npm/alpinejs@3.x.x/dist/cdn.min.js"></script>
</head>
<body class="bg-gray-950 text-gray-200 font-sans h-screen flex overflow-hidden selection:bg-blue-500/30" x-data="app()">
    
    <aside class="w-64 bg-gray-900 border-r border-gray-800 flex flex-col z-10">
        <div class="p-6 flex items-center gap-3 border-b border-gray-800">
            <div class="w-10 h-10 rounded-full bg-blue-600 flex items-center justify-center font-bold text-2xl shadow-[0_0_15px_rgba(37,99,235,0.6)] text-white">J</div>
            <div>
                <h1 class="text-xl font-bold tracking-tight text-white">JEV</h1>
                <p class="text-[10px] text-gray-500 uppercase tracking-widest font-semibold">Control Center</p>
            </div>
        </div>
        
        <nav class="flex-1 p-4 space-y-1">
            <a href="#dashboard" :class="currentTab === '#dashboard' ? 'bg-gray-800 text-white' : 'text-gray-400 hover:bg-gray-800/50 hover:text-white'" class="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors">
                <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6"/></svg>
                Dashboard
            </a>
            <a href="#logs" :class="currentTab === '#logs' ? 'bg-gray-800 text-white' : 'text-gray-400 hover:bg-gray-800/50 hover:text-white'" class="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors">
                <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 10h16M4 14h16M4 18h16"/></svg>
                Logs
            </a>
            <a href="#settings" :class="currentTab === '#settings' ? 'bg-gray-800 text-white' : 'text-gray-400 hover:bg-gray-800/50 hover:text-white'" class="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors">
                <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/></svg>
                Configurações
            </a>
            <a href="#capabilities" :class="currentTab === '#capabilities' ? 'bg-gray-800 text-white' : 'text-gray-400 hover:bg-gray-800/50 hover:text-white'" class="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors">
                <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z"/></svg>
                Capabilities
            </a>
        </nav>
        
        <div class="p-4 border-t border-gray-800">
            <div class="flex items-center gap-3 mb-2">
                <div class="relative inline-flex h-6 w-11 items-center rounded-full transition-colors cursor-pointer" :class="state.enabled ? 'bg-blue-600' : 'bg-gray-600'" @click="toggleState">
                    <span class="inline-block h-4 w-4 transform rounded-full bg-white transition-transform" :class="state.enabled ? 'translate-x-6' : 'translate-x-1'"></span>
                </div>
                <span class="text-xs font-semibold uppercase tracking-wider" :class="state.enabled ? 'text-blue-400' : 'text-gray-500'" x-text="state.enabled ? 'Ativo' : 'Desativado'"></span>
            </div>
        </div>
    </aside>

    <main class="flex-1 bg-gray-950 overflow-hidden relative">
        <div x-show="currentTab === '#dashboard'" class="h-full p-8 overflow-y-auto" x-cloak>
            <h2 class="text-3xl font-bold text-white mb-6">Dashboard de Execuções</h2>
            
            <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
                <div class="bg-gray-900 border border-gray-800 rounded-xl p-6 shadow-sm">
                    <h3 class="text-sm font-medium text-gray-400 mb-1">Total de Chamadas JEV</h3>
                    <p class="text-4xl font-black text-white" x-text="state.stats?.totalCalls || 0"></p>
                </div>
            </div>
            
            <h3 class="text-lg font-bold text-white mb-4 border-b border-gray-800 pb-2">Roteamento por Modelos LLM</h3>
            <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
                <template x-for="(count, model) in state.stats?.models || {}" :key="model">
                    <div class="bg-gray-900 border border-gray-800 rounded-xl p-5 flex justify-between items-center">
                        <div class="truncate pr-4 flex-1">
                            <h4 class="text-sm font-medium text-gray-300 truncate" x-text="model" :title="model"></h4>
                            <p class="text-xs text-gray-500 mt-1">Requisições processadas</p>
                        </div>
                        <div class="text-2xl font-bold text-blue-400 bg-blue-900/20 px-4 py-2 rounded-lg" x-text="count"></div>
                    </div>
                </template>
                <div x-show="!state.stats?.models || Object.keys(state.stats.models).length === 0" class="text-gray-500 italic text-sm">Nenhum dado de roteamento ainda.</div>
            </div>
        </div>

        <div x-show="currentTab === '#logs'" class="h-full flex flex-col p-6" x-cloak x-data="logViewer()">
            <div class="flex justify-between items-end mb-4">
                <h2 class="text-2xl font-bold text-white">Live Diagnostics Log</h2>
                <div class="flex items-center gap-4">
                    <div class="flex items-center gap-2 bg-gray-900 border border-gray-800 rounded-lg p-1.5 shadow-sm">
                        <span class="text-xs text-gray-500 font-bold uppercase ml-2">Mostrar:</span>
                        <select x-model.number="limit" class="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-white text-xs focus:border-blue-500 focus:outline-none">
                            <option value="10">10</option>
                            <option value="30">30</option>
                            <option value="50">50</option>
                            <option value="100">100</option>
                            <option value="500">500</option>
                        </select>
                        <div class="w-px h-4 bg-gray-700 mx-1"></div>
                        <span class="text-xs text-gray-500 font-bold uppercase">Limpar:</span>
                        <select x-model="clearTimeframe" class="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-white text-xs focus:border-blue-500 focus:outline-none">
                            <option value="all">Tudo</option>
                            <option value="5m">Últimos 5 min</option>
                            <option value="30m">Últimos 30 min</option>
                            <option value="1h">Última 1 hora</option>
                        </select>
                        <button @click="clearLogs" title="Limpar Logs" class="bg-red-600/80 hover:bg-red-600 text-white rounded p-1 transition-colors">
                            <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>
                        </button>
                        <div class="w-px h-4 bg-gray-700 mx-1"></div>
                        <button @click="downloadLogs" title="Baixar Logs" class="bg-emerald-600/80 hover:bg-emerald-600 text-white rounded p-1 transition-colors">
                            <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/></svg>
                        </button>
                    </div>
                    <div class="flex bg-gray-900 border border-gray-800 rounded-lg p-1 gap-1">
                        <button @click="mode = 'classifications'" :class="mode === 'classifications' ? 'bg-gray-800 text-white shadow' : 'text-gray-400 hover:text-gray-200'" class="px-4 py-1.5 text-sm font-medium rounded-md transition-all">Classificações</button>
                        <button @click="mode = 'advanced'" :class="mode === 'advanced' ? 'bg-gray-800 text-white shadow' : 'text-gray-400 hover:text-gray-200'" class="px-4 py-1.5 text-sm font-medium rounded-md transition-all">Avançado</button>
                    </div>
                </div>
            </div>
            
            <div x-show="mode === 'advanced'" id="advancedContainer" class="flex-1 bg-gray-900 border border-gray-800 rounded-xl p-4 font-mono text-sm overflow-y-auto shadow-inner relative">
                <template x-for="log in filteredLogs" :key="log.id">
                    <div class="py-0.5 border-b border-gray-800/30 hover:bg-gray-800/50" x-html="log.html"></div>
                </template>
            </div>

            <div x-show="mode === 'classifications'" id="classificationsContainer" class="flex-1 overflow-y-auto pr-2">
                <template x-for="item in filteredClassifications" :key="item.id">
                    <div class="mb-4 border border-gray-800 rounded-lg p-4 bg-gray-900 shadow-sm flex flex-col">
                        <div class="text-xs text-gray-500 mb-2" x-text="item.timestamp"></div>
                        <div class="mb-3">
                            <span class="text-xs font-bold text-gray-400 uppercase tracking-wider">Input Context</span>
                            <div class="mt-1 bg-black text-gray-300 p-3 rounded font-serif text-sm border border-gray-800 whitespace-pre-wrap" x-text="item.request || item.tool || ''"></div>
                        </div>
                        <div>
                            <span class="text-xs font-bold text-gray-400 uppercase tracking-wider">JEV Decision</span>
                            <div class="mt-1 flex flex-wrap gap-6 bg-gray-950 p-3 rounded border border-gray-800 text-sm">
                                <div>
                                    <span class="text-gray-500">Domain:</span> 
                                    <span class="font-bold text-emerald-400" x-text="item.domain || 'N/A'"></span>
                                    <span class="text-xs text-gray-500" x-text="'(conf: ' + (item.domainConf ?? 'N/A') + ')'"></span>
                                </div>
                                <div x-show="item.complexityScore !== undefined">
                                    <span class="text-gray-500">Complexity:</span> 
                                    <span class="font-bold text-amber-400" x-text="item.complexityScore ?? 'N/A'"></span>
                                    <span class="text-xs text-gray-500" x-text="'(conf: ' + (item.complexityConf ?? 'N/A') + ')'"></span>
                                </div>
                            </div>
                        </div>
                    </div>
                </template>
                <div x-show="filteredClassifications.length === 0" class="text-gray-500 italic text-sm p-4 text-center">Nenhuma classificação registrada ainda.</div>
            </div>
        </div>

        <div x-show="currentTab === '#settings'" class="h-full p-8 overflow-y-auto" x-cloak>
            <h2 class="text-3xl font-bold text-white mb-6">Configurações</h2>
            
            <div class="grid grid-cols-1 xl:grid-cols-2 gap-8">
                <div class="bg-gray-900 border border-gray-800 rounded-xl p-6 shadow-sm">
                    <h3 class="text-xl font-bold text-white mb-6 border-b border-gray-800 pb-2">Controle do Interceptador</h3>
                    
                    <div class="mb-8">
                        <h4 class="text-sm font-bold text-gray-300 mb-1">Estado Principal</h4>
                        <p class="text-xs text-gray-500 mb-3">Ligar ou desligar o JEV globalmente.</p>
                        <button @click="toggleState" class="relative inline-flex h-8 w-14 items-center rounded-full transition-colors focus:outline-none" :class="state.enabled ? 'bg-blue-600' : 'bg-gray-600'">
                            <span class="inline-block h-6 w-6 transform rounded-full bg-white transition-transform" :class="state.enabled ? 'translate-x-7' : 'translate-x-1'"></span>
                        </button>
                    </div>
                    
                    <div class="mb-4">
                        <h4 class="text-sm font-bold text-gray-300 mb-1">Limiar de Confiança (Bypass Threshold)</h4>
                        <p class="text-xs text-gray-500 mb-3">Se a confiança da classificação for menor, o JEV faz bypass silencioso.</p>
                        <div class="flex items-center gap-4">
                            <input type="range" min="0" max="1" step="0.05" x-model="state.confidenceThreshold" @change="updateState" class="w-full h-2 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-blue-500">
                            <span class="font-mono text-blue-400 font-bold bg-blue-900/30 px-3 py-1 rounded w-16 text-center" x-text="parseFloat(state.confidenceThreshold).toFixed(2)"></span>
                        </div>
                        <div class="flex justify-between text-[10px] text-gray-500 mt-2 px-1 uppercase tracking-wider">
                            <span>Permissivo (0.0)</span>
                            <span>Restritivo (1.0)</span>
                        </div>
                    </div>

                    <div class="mb-4 pt-4 border-t border-gray-800">
                        <h4 class="text-sm font-bold text-gray-300 mb-1">Guardrail Bloqueante (Block Dangerous)</h4>
                        <p class="text-xs text-gray-500 mb-3">Quando ligado, tool calls destrutivos detectados pelo JEV são bloqueados antes de executar. Desligado, apenas registra no log.</p>
                        <button @click="toggleBlockDangerous" class="relative inline-flex h-8 w-14 items-center rounded-full transition-colors focus:outline-none" :class="state.blockDangerous ? 'bg-red-600' : 'bg-gray-600'">
                            <span class="inline-block h-6 w-6 transform rounded-full bg-white transition-transform" :class="state.blockDangerous ? 'translate-x-7' : 'translate-x-1'"></span>
                        </button>
                    </div>
                </div>

                <div class="bg-gray-900 border border-gray-800 rounded-xl p-6 shadow-sm">
                    <h3 class="text-xl font-bold text-white mb-6 border-b border-gray-800 pb-2">Camada de Orquestração (OpenCode)</h3>
                    
                    <form @submit.prevent="saveOrchestration" class="space-y-5">
                        <div>
                            <label class="block text-sm font-bold text-gray-300 mb-1">OpenRouter API Key</label>
                            <p class="text-xs text-gray-500 mb-2">Chave de acesso. Substituída por {env:OPENROUTER_API_KEY} no arquivo local.</p>
                            <input type="password" x-model="config.openrouter_key" placeholder="sk-or-v1-..." class="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-white text-sm focus:border-blue-500 focus:outline-none">
                        </div>

                        <div>
                            <label class="block text-sm font-bold text-gray-300 mb-1">Intra-Loop Router</label>
                            <input type="text" x-model="config.jev_model" readonly class="w-full bg-gray-800/50 border border-gray-700/50 rounded px-3 py-2 text-gray-400 text-sm cursor-not-allowed">
                        </div>

                        <div>
                            <label class="block text-sm font-bold text-gray-300 mb-1">Context Harvester (Small Model)</label>
                            <select x-model="config.small_model" class="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-white text-sm focus:border-blue-500 focus:outline-none">
                                <template x-for="provider in Object.keys(groupedModels)" :key="provider">
                                    <optgroup :label="provider">
                                        <template x-for="m in groupedModels[provider]" :key="m.id">
                                            <option :value="m.id" x-text="m.name" :selected="config.small_model === m.id"></option>
                                        </template>
                                    </optgroup>
                                </template>
                            </select>
                        </div>

                        <div>
                            <label class="block text-sm font-bold text-gray-300 mb-1">Strategic Planner (Fallback Agent)</label>
                            <select x-model="config.planner_model" class="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-white text-sm focus:border-blue-500 focus:outline-none">
                                <template x-for="provider in Object.keys(groupedModels)" :key="provider">
                                    <optgroup :label="provider">
                                        <template x-for="m in groupedModels[provider]" :key="m.id">
                                            <option :value="m.id" x-text="m.name" :selected="config.planner_model === m.id"></option>
                                        </template>
                                    </optgroup>
                                </template>
                            </select>
                        </div>

                        <button type="submit" class="w-full bg-blue-600 hover:bg-blue-700 text-white font-bold py-2.5 px-4 rounded transition-colors text-sm" :disabled="saving">
                            <span x-show="!saving">Salvar Orquestração</span>
                            <span x-show="saving">Salvando...</span>
                        </button>
                        <p x-show="saveSuccess" class="text-green-400 text-xs text-center mt-2" x-transition>Configurações salvas!</p>
                    </form>
                </div>
            </div>
        </div>

        <div x-show="currentTab === '#capabilities'" class="h-full p-8 overflow-y-auto" x-cloak>
            <h2 class="text-3xl font-bold text-white mb-6">Capabilities & Context</h2>
            
            <div class="prose prose-invert max-w-none text-gray-300">
                <div class="bg-gray-900 border border-gray-800 rounded-xl p-6 mb-6">
                    <h3 class="text-xl font-bold text-white mb-4">O que é o JEV?</h3>
                    <p class="mb-4">O JEV (Judge, Evaluator and Validator) atua como um <strong>Gatekeeper & Escalator</strong> no fluxo do OpenCode. Ele intercepta as intenções do usuário antes que atinjam o modelo executor padrão, avaliando o domínio da ferramenta necessária e a complexidade da tarefa.</p>
                </div>

                <div class="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
                    <div class="bg-gray-900 border border-gray-800 rounded-xl p-6">
                        <h4 class="text-lg font-bold text-blue-400 mb-3">Model Routing (Escalonamento Dinâmico)</h4>
                        <ul class="space-y-2 text-sm list-disc pl-5">
                            <li><strong>TRIVIAL:</strong> Roteia para modelos pequenos e rápidos (ex: Nemotron, Gemini Flash) para tarefas como linting, formatação e perguntas simples.</li>
                            <li><strong>STANDARD:</strong> Mantém o executor atual (ex: Claude Sonnet 4.6) para desenvolvimento regular de features.</li>
                            <li><strong>COMPLEX:</strong> Aciona o Strategic Planner (ex: Claude Opus 4.6 Thinking) para arquitetura, debugging profundo e bloqueios sistemáticos.</li>
                        </ul>
                    </div>

                    <div class="bg-gray-900 border border-gray-800 rounded-xl p-6">
                        <h4 class="text-lg font-bold text-emerald-400 mb-3">Tool Domains (Filtro de Ferramentas)</h4>
                        <ul class="space-y-2 text-sm list-disc pl-5">
                            <li><strong>FILE_SYSTEM:</strong> Read, write, grep, glob, todowrite.</li>
                            <li><strong>SHELL_EXECUTION:</strong> Bash (npm, git, docker).</li>
                            <li><strong>BROWSER_AUTOMATION:</strong> Playwright MCP (navigate, click, snapshot).</li>
                            <li><strong>HOSTING_AGENCY:</strong> Web Hosting MCP (deploy, domains, databases).</li>
                            <li><strong>OBSIDIAN_VAULT:</strong> Obsidian MCP (read notes, manage PKM).</li>
                        </ul>
                    </div>
                </div>
            </div>
        </div>
    </main>

    <script>
        document.addEventListener('alpine:init', () => {
            Alpine.data('app', () => ({
                currentTab: window.location.hash || '#dashboard',
                state: { enabled: false, confidenceThreshold: 0.6, blockDangerous: false, stats: { totalCalls: 0, models: {} } },
                config: { openrouter_key: '', jev_model: '', small_model: '', planner_model: '', available_models: [] },
                saving: false,
                saveSuccess: false,
                init() {
                    window.addEventListener('hashchange', () => {
                        this.currentTab = window.location.hash || '#dashboard';
                    });
                    this.fetchData();
                    setInterval(() => fetch('/api/heartbeat').catch(()=>console.warn('Heartbeat failed')), 2000);
                },
                async fetchData() {
                    try {
                        const res = await fetch('/api/data');
                        const data = await res.json();
                        this.state = { enabled: false, confidenceThreshold: 0.6, blockDangerous: false, stats: { totalCalls: 0, models: {} }, ...data.state };
                        this.config = data.config;
                    } catch(e) { console.error("Failed to load data", e); }
                },
                async updateState() {
                    try {
                        await fetch('/api/state', {
                            method: 'POST',
                            headers: {'Content-Type': 'application/json'},
                            body: JSON.stringify(this.state)
                        });
                        this.fetchData();
                    } catch(e) { console.error("Failed to save state", e); }
                },
                async toggleState() {
                    this.state.enabled = !this.state.enabled;
                    await this.updateState();
                },
                async toggleBlockDangerous() {
                    this.state.blockDangerous = !this.state.blockDangerous;
                    await this.updateState();
                },
                async saveOrchestration() {
                    this.saving = true;
                    this.saveSuccess = false;
                    try {
                        const payload = {
                            openrouter_key: this.config.openrouter_key,
                            jev_model: this.config.jev_model,
                            small_model: this.config.small_model,
                            planner_model: this.config.planner_model
                        };
                        const res = await fetch('/api/config', {
                            method: 'POST',
                            headers: {'Content-Type': 'application/json'},
                            body: JSON.stringify(payload)
                        });
                        if (res.ok) {
                            this.saveSuccess = true;
                            setTimeout(() => this.saveSuccess = false, 3000);
                        } else {
                            alert("Failed to save orchestration config.");
                        }
                    } catch(e) {
                        alert("Error saving: " + e.message);
                    } finally {
                        this.saving = false;
                    }
                },
                get groupedModels() {
                    const groups = {};
                    for(const m of this.config.available_models) {
                        if(!groups[m.provider]) groups[m.provider] = [];
                        groups[m.provider].push(m);
                    }
                    return groups;
                }
            }));

            Alpine.data('logViewer', () => ({
                mode: 'classifications',
                limit: 50,
                clearTimeframe: 'all',
                logs: [],
                classifications: [],
                logIdCounter: 0,
                init() {
                    const evtSource = new EventSource('/api/logs');
                    evtSource.onmessage = (e) => {
                        let text = e.data;
                        let type = 'info';
                        
                        if(text.toLowerCase().includes('error') || text.toLowerCase().includes('failed')) { text = '<span class="text-red-400">' + text + '</span>'; type = 'error'; }
                        else if(text.includes('JEV IS ENABLED') || text.includes('Routing to')) { text = '<span class="text-purple-400 font-bold">' + text + '</span>'; type = 'class'; }
                        else { text = '<span class="text-gray-300">' + text + '</span>'; }
                        
                        this.logs.push({ id: this.logIdCounter++, raw: e.data, html: text, type });
                        if(this.logs.length > 500) this.logs.shift();

                        this.$nextTick(() => {
                            const container = document.getElementById('advancedContainer');
                            if(container && container.scrollHeight - container.clientHeight <= container.scrollTop + 60) {
                                container.scrollTop = container.scrollHeight;
                            }
                        });
                    };

                    const classSource = new EventSource('/api/classifications');
                    classSource.onmessage = (e) => {
                        try {
                            const parsed = JSON.parse(e.data);
                            this.classifications.push({ id: this.logIdCounter++, ...parsed });
                            if(this.classifications.length > 500) this.classifications.shift();
                            
                            this.$nextTick(() => {
                                const container = document.getElementById('classificationsContainer');
                                if(container && container.scrollHeight - container.clientHeight <= container.scrollTop + 80) {
                                    container.scrollTop = container.scrollHeight;
                                }
                            });
                        } catch(err) {}
                    };
                },
                get filteredLogs() {
                    return this.logs.slice(-this.limit);
                },
                get filteredClassifications() {
                    return this.classifications.slice(-this.limit);
                },
                async clearLogs() {
                    if(!confirm(\`Tem certeza que deseja limpar [\${this.clearTimeframe}] do log \${this.mode === 'advanced' ? 'Avançado' : 'de Classificações'}?\`)) return;
                    
                    try {
                        await fetch('/api/logs/clear', {
                            method: 'POST',
                            headers: {'Content-Type': 'application/json'},
                            body: JSON.stringify({ timeframe: this.clearTimeframe, type: this.mode })
                        });
                        
                        if (this.clearTimeframe === 'all') {
                            if (this.mode === 'advanced') this.logs = [];
                            else this.classifications = [];
                        } else {
                            const msMap = { '5m': 300000, '30m': 1800000, '1h': 3600000 };
                            const cutoff = Date.now() - (msMap[this.clearTimeframe] || 0);
                            
                            if (this.mode === 'advanced') {
                                this.logs = this.logs.filter(l => {
                                    const m = l.raw.match(/^(\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2})/);
                                    if (m) {
                                        const d = new Date(m[1].replace(' ', 'T')).getTime();
                                        return d <= cutoff;
                                    }
                                    return true;
                                });
                            } else {
                                this.classifications = this.classifications.filter(c => {
                                    const d = new Date(c.timestamp.replace(' ', 'T')).getTime();
                                    return d <= cutoff;
                                });
                            }
                        }
                    } catch(e) { console.error("Error clearing logs", e); }
                },
                downloadLogs() {
                    let content = '';
                    let filename = '';
                    
                    if (this.mode === 'advanced') {
                        content = this.filteredLogs.map(l => l.raw).join('\\n');
                        filename = 'jev_advanced_logs.txt';
                    } else {
                        content = this.filteredClassifications.map(c => {
                            const { id, ...rest } = c;
                            return JSON.stringify(rest);
                        }).join('\\n');
                        filename = 'jev_classifications.jsonl';
                    }
                    
                    if (!content) return alert("Nenhum log para baixar.");
                    
                    const blob = new Blob([content], { type: 'text/plain' });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = filename;
                    document.body.appendChild(a);
                    a.click();
                    document.body.removeChild(a);
                    URL.revokeObjectURL(url);
                }
            }));
        });
    </script>
</body>
</html>`;

const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }

    if (req.url === '/') {
        res.writeHead(200, {'Content-Type': 'text/html'});
        res.end(html);
    } 
    else if (req.url === '/api/data' && req.method === 'GET') {
        const state = getJevState();
        const oc = readConfig();
        const currentKey = oc.provider?.openrouter?.options?.apiKey ?? "";
        const safeKey = currentKey && !currentKey.startsWith("{env:") ? currentKey : "";
        
        const data = {
            state,
            config: {
                openrouter_key: safeKey,
                jev_model: oc.decisionModel ?? "typesafe/jev-1.13",
                small_model: oc.small_model ?? "",
                planner_model: oc.agent?.plan?.model ?? "",
                available_models: getAvailableModels(oc)
            }
        };
        res.writeHead(200, {'Content-Type': 'application/json'});
        res.end(JSON.stringify(data));
    }
    else if (req.url === '/api/state' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk.toString());
        req.on('end', () => {
            try {
                const newState = JSON.parse(body);
                saveJevState(newState);
                res.writeHead(200, {'Content-Type': 'application/json'});
                res.end(JSON.stringify(newState));
            } catch(e) {
                res.writeHead(400);
                res.end('Invalid JSON');
            }
        });
    }
    else if (req.url === '/api/config' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk.toString());
        req.on('end', async () => {
            try {
                const payload = JSON.parse(body);
                await saveOpencodeConfig(payload);
                res.writeHead(200, {'Content-Type': 'application/json'});
                res.end(JSON.stringify({success: true}));
            } catch(e) {
                res.writeHead(500);
                res.end((e as Error).message);
            }
        });
    }
    else if (req.url === '/api/heartbeat') {
        hasConnected = true;
        lastHeartbeat = Date.now();
        res.writeHead(200, {'Access-Control-Allow-Origin': '*'});
        res.end('ok');
    } 
    else if (req.url === '/api/logs') {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive'
        });

        if (fs.existsSync(logFile)) {
            const lines = fs.readFileSync(logFile, 'utf8').split('\n').slice(-150);
            for(const line of lines) {
                if(line.trim()) res.write(`data: ${line.trim()}\n\n`);
            }
        }

        let lastSize = fs.existsSync(logFile) ? fs.statSync(logFile).size : 0;
        const interval = setInterval(() => {
            if (fs.existsSync(logFile)) {
                const stat = fs.statSync(logFile);
                if (stat.size > lastSize) {
                    const stream = fs.createReadStream(logFile, { start: lastSize, end: stat.size });
                    let buffer = '';
                    stream.on('data', chunk => {
                        buffer += chunk.toString();
                        const lines = buffer.split('\n');
                        buffer = lines.pop() || ''; 
                        for(const line of lines) {
                            if(line.trim()) res.write(`data: ${line.trim()}\n\n`);
                        }
                    });
                    lastSize = stat.size;
                } else if (stat.size < lastSize) {
                    lastSize = stat.size;
                }
            }
        }, 300);

        req.on('close', () => clearInterval(interval));
    }
    else if (req.url === '/api/classifications') {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive'
        });

        if (fs.existsSync(classLogFile)) {
            const lines = fs.readFileSync(classLogFile, 'utf8').split('\n').slice(-150);
            for(const line of lines) {
                if(line.trim()) res.write(`data: ${line.trim()}\n\n`);
            }
        }

        let lastSize = fs.existsSync(classLogFile) ? fs.statSync(classLogFile).size : 0;
        const interval = setInterval(() => {
            if (fs.existsSync(classLogFile)) {
                const stat = fs.statSync(classLogFile);
                if (stat.size > lastSize) {
                    const stream = fs.createReadStream(classLogFile, { start: lastSize, end: stat.size });
                    let buffer = '';
                    stream.on('data', chunk => {
                        buffer += chunk.toString();
                        const lines = buffer.split('\n');
                        buffer = lines.pop() || ''; 
                        for(const line of lines) {
                            if(line.trim()) res.write(`data: ${line.trim()}\n\n`);
                        }
                    });
                    lastSize = stat.size;
                } else if (stat.size < lastSize) {
                    lastSize = stat.size;
                }
            }
        }, 300);

        req.on('close', () => clearInterval(interval));
    }
    else if (req.url === '/api/logs/clear' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk.toString());
        req.on('end', () => {
            try {
                const { timeframe, type } = JSON.parse(body);
                const file = type === 'advanced' ? logFile : classLogFile;
                
                if (!fs.existsSync(file)) {
                    res.writeHead(200);
                    return res.end(JSON.stringify({success: true}));
                }

                if (timeframe === 'all') {
                    fs.writeFileSync(file, '');
                } else {
                    const msMap: Record<string, number> = { '5m': 5 * 60000, '30m': 30 * 60000, '1h': 60 * 60000 };
                    const cutoff = Date.now() - (msMap[timeframe] || 0);

                    const lines = fs.readFileSync(file, 'utf8').split('\n');
                    const keepLines: string[] = [];

                    for (const line of lines) {
                        if (!line.trim()) continue;
                        let dStr: string | null = null;
                        
                        if (type === 'advanced') {
                            const match = line.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/);
                            if (match) dStr = match[1];
                        } else {
                            try {
                                const obj = JSON.parse(line);
                                dStr = obj.timestamp;
                            } catch(e) {}
                        }

                        let shouldKeep = true;
                        if (dStr) {
                            const lineTime = new Date(dStr.replace(' ', 'T')).getTime();
                            if (lineTime > cutoff) {
                                shouldKeep = false; 
                            }
                        }
                        if (shouldKeep) keepLines.push(line);
                    }
                    fs.writeFileSync(file, keepLines.join('\n') + (keepLines.length > 0 ? '\n' : ''));
                }
                res.writeHead(200, {'Content-Type': 'application/json'});
                res.end(JSON.stringify({success: true}));
            } catch(e) {
                res.writeHead(500);
                res.end('Error clearing logs');
            }
        });
    } else {
        res.writeHead(404);
        res.end();
    }
});

server.on('error', (e: any) => {
    if (e.code === 'EADDRINUSE') {
        console.log('Dashboard already running. Opening browser...');
        openBrowser(`http://localhost:${port}`);
        setTimeout(() => process.exit(0), 1000);
    }
});

server.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
    openBrowser(`http://localhost:${port}`);
    startSystemTray();
});

// ---------------------------------------------------------------------------
// System Tray — keeps the server alive and gives quick access
// ---------------------------------------------------------------------------
function resolveIconPath(): string | null {
    const candidates = [
        path.join(moduleDir, '..', '..', 'assets', 'jev_icon.ico'),
        path.join(configDir, 'jev_icon.ico'),
    ];
    for (const c of candidates) {
        if (fs.existsSync(c)) return c;
    }
    return null;
}

function startSystemTray(): void {
    try {
        const iconPath = resolveIconPath();
        if (!iconPath) {
            console.error('System Tray: jev_icon.ico not found; tray disabled.');
            return;
        }
        const iconData = fs.readFileSync(iconPath).toString('base64');
        const SysTray = (SysTrayModule as any).default ?? SysTrayModule;

        let systray: any;

        const itemOpen: any = {
            title: "Abrir Dashboard",
            tooltip: "Abre o painel no navegador",
            checked: false,
            enabled: true,
            click: () => openBrowser(`http://localhost:${port}`),
        };
        const itemToggle: any = {
            title: "Ligar/Desligar JEV",
            tooltip: "Alterna o estado do interceptador",
            checked: false,
            enabled: true,
            click: () => {
                const s = getJevState();
                s.enabled = !s.enabled;
                saveJevState(s);
                itemToggle.title = s.enabled ? "Desligar JEV" : "Ligar JEV";
                systray.sendAction({ type: 'update-item', item: itemToggle });
            },
        };
        const itemExit: any = {
            title: "Encerrar Servidor",
            tooltip: "Fecha definitivamente o servidor JEV",
            checked: false,
            enabled: true,
            click: () => {
                systray.kill();
                setTimeout(() => process.exit(0), 500);
            },
        };

        systray = new SysTray({
            menu: {
                icon: iconData,
                title: "JEV Dashboard",
                tooltip: "JEV Control Center",
                items: [itemOpen, itemToggle, itemExit],
            },
            debug: false,
            copyDir: true,
        });

        systray.onClick((action: any) => {
            if (action.item.click != null) action.item.click();
        });

        systray.ready()
            .then(() => {
                const s = getJevState();
                itemToggle.title = s.enabled ? "Desligar JEV" : "Ligar JEV";
                systray.sendAction({ type: 'update-item', item: itemToggle });
            })
            .catch((err: any) => console.error('Falha ao iniciar System Tray:', err));
    } catch (err) {
        console.error('Erro no setup do System Tray:', (err as Error).message);
    }
}