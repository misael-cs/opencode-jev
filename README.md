# opencode-jev

JEV Orchestrator plugin for [OpenCode](https://opencode.ai) — O(1) intra-loop tool routing via the [Typesafe JEV](https://openrouter.ai/typesafe/jev-1.13) model on OpenRouter.

## What is JEV?

Traditional agentic loops (System 2) require the LLM to generate a Chain-of-Thought before selecting a tool. This costs tokens and latency on every turn.

JEV is a non-autoregressive **System 1** classifier: it reads the user context and returns the correct tool domain in O(1) time, before the main LLM acts. The LLM then acts as a "blind" executor, formatting only the tool call JEV designated — skipping CoT entirely.

If JEV confidence is below 60%, or if the API is unavailable, the hook bypasses silently and lets the native LLM reason freely. No disruption to normal operation.

## Prerequisites

- [OpenCode](https://opencode.ai) installed and run at least once
- An [OpenRouter](https://openrouter.ai) API key (`sk-or-v1-...`) with access to `typesafe/jev-1.13`

## Installation

```bash
npx opencode-jev install
```

The installer will:
1. Add `"opencode-jev"` to your `opencode.jsonc` plugin array
2. Prompt for your OpenRouter API key and save it to config
3. Install the `Jev` agent definition to your OpenCode agent directory

Then restart OpenCode.

## Usage

**Enable JEV routing:** Press `Ctrl+O` in OpenCode and select the **Jev** agent.

**Disable:** Switch back to any other agent (Build, Plan, etc.) — the hook bypasses automatically.

**Control Panel** (manage auxiliary models and API key):

```bash
npx opencode-jev panel
# Opens http://localhost:3040
```

Optional port:

```bash
npx opencode-jev panel 4000
```

**Uninstall:**

```bash
npx opencode-jev uninstall
```

## Routing Categories

JEV classifies each turn into one of 8 tool domains:

| Category | When used |
|---|---|
| `FS_READ` | Read files, explore directories, search codebase |
| `FS_WRITE` | Write, edit, or create source files |
| `OS_EXECUTION` | Run shell commands, scripts, containers |
| `WEB_AUTOMATION` | Browser control (Playwright), scraping, testing |
| `KNOWLEDGE_RETRIEVAL` | Obsidian, web search, documentation |
| `INFRA_MANAGEMENT` | VPS, DNS, Hostinger, domain management |
| `WORKFLOW_CONTROL` | TODOs, sub-agents, asking the user questions |
| `FINAL_ANSWER` | Prose-only responses, no tool needed |

## Debug Log

All hook activity, bypasses and errors are written to:

- **Windows:** `%APPDATA%\opencode\jev_debug.log`
- **Linux/macOS:** `~/.config/opencode/jev_debug.log`

## Known Limitations

- **Log-scan detection:** JEV activation is detected by scanning the OpenCode runtime log for `agent=Jev`. A 250ms delay is introduced at hook start to ensure OpenCode has flushed the log to disk.
- **Plaintext API key:** The OpenRouter key is stored in `opencode.jsonc`. A future version will support `{env:OPENROUTER_API_KEY}` once OpenCode resolves env vars in plugin hooks reliably on Windows.
- **Confidence tuning:** If JEV consistently bypasses on a specific task, sharpen the `criteria` descriptions in `src/plugin.ts` — JEV's routing is entirely semantic, no retraining required.

## Control Panel

The panel (`npx opencode-jev panel`) manages three background layers:

- **OpenRouter API Key** — consumed by the plugin hook
- **Small Model** — Context Harvester for log scanning and fast tasks
- **Strategic Planner** — Fallback agent for complex architecture decisions

The primary Core Worker model is intentionally excluded — change it directly in the OpenCode TUI.

## License

MIT
