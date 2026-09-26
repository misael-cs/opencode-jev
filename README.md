# opencode-jev

The **JEV Orchestrator** is an ultra-aggressive, high-performance plugin for [OpenCode](https://opencode.ai). It replaces traditional "System 2" LLM tool-calling loops with a deterministic, non-autoregressive **System 1** classifier via [Typesafe JEV](https://openrouter.ai/typesafe/jev-1.13) on OpenRouter.

By intercepting the agentic loop, JEV evaluates the state of the conversation in **O(1) latency** (~150ms) and simultaneously determines two critical axes:
1. **The Tool Domain:** Which tool or MCP server should be used.
2. **The Task Complexity:** How deep the cognitive reasoning needs to be.

## Core Capabilities

### 1. Dynamic Complexity Routing (On-The-Fly Model Swapping)
Traditional agentic loops use a single heavy model (e.g., Claude 3.5 Sonnet) for everything—from writing complex algorithms to running `ls` or reading a terminal error. JEV evaluates the cognitive complexity of each turn and dynamically swaps the model in the background:
- 🟢 **`TRIVIAL`:** (Simple text formatting, reading single files, standard terminal execution). The plugin forces OpenCode to use an ultra-fast, cheap **Small Model** (e.g., MiMo, Gemini Flash).
- 🟡 **`STANDARD`:** (Writing components, local refactoring). The plugin preserves your default **Core Worker** (e.g., Sonnet 4.6).
- 🔴 **`COMPLEX`:** (Deep algorithmic debugging, race conditions, systemic failures). The plugin escalates to the **Strategic Planner** (e.g., Claude Opus Thinking). Once resolved, the next turn gracefully downscales back to trivial.

### 2. Algorithmic Search & Classification (The JEV CLI)
Do not waste thousands of tokens using `grep` or reading entire files into context. The JEV CLI empowers the LLM to search for *semantic concepts* algorithmically across your entire codebase or Obsidian Vault.
```bash
npx opencode-jev scan "Does this file contain the database connection string?" ./src/
```
The CLI chunks the files, queries JEV in parallel, and returns the exact matching files in seconds.

### 3. Persistent Context Basket (Anti-Amnesia Memory)
Long LLM loops suffer from context-window sliding. JEV fixes this by shifting memory management to the agent itself. At any time, the LLM can run:
```bash
npx opencode-jev context "Update: 1. DB setup complete. 2. Bug is in line 45."
```
This updates a persistent file in the workspace (`.opencode/jev_context.md`) that the JEV plugin automatically injects into the very top of the System Prompt on every subsequent turn, completely eliminating context loss.

### 4. Dynamic MCP Routing
JEV dynamically parses your `opencode.jsonc` file to discover installed MCP (Model Context Protocol) servers. It cross-references them with a rich internal semantic catalog (`obsidian`, `postgres`, `github`, `puppeteer`, etc.) and automatically routes intents to external technologies with zero hardcoding.

### 5. Polyvalent LLM Guardrails (Pre-Execution Safety)
Every tool call — built-in (`bash`, `write`, `edit`), MCP tools (Hostinger, VPS, DNS, databases), or any custom tool — passes through a semantic `noul` check **before executing**:

> *"Could this tool call cause data loss, modify or delete production systems, expose credentials, or perform an irreversible destructive action?"*

- Tools with unambiguously read-only names (`listWebsitesV1`, `getDNSRecords`, `search-vault`) skip the check to save latency.
- Compound traps (`get_or_create`, `search-and-replace`) and hidden mutations are always checked.
- Default behavior: **log only** (detections are written to `jev_classifications.jsonl`).
- Opt-in hard blocking: enable **Guardrail Bloqueante** in the web panel to `throw` before destructive tools run.

### 6. Reactive Mid-Loop Escalation (Harness Engineering)
After every tool execution, JEV classifies the output:

> *"Does this tool output indicate an error, failure, or unexpected result?"*

Consecutive failures (default: 2) trip a per-session escalation flag. On the very next turn, the orchestrator **forces the Strategic Planner model** regardless of the initial complexity score — then resets. This is the canonical TypeSafe pattern applied to the AGENTS.md *Mid-Loop Escalation* policy: failures detected at lightspeed, escalation only when the executor is actually stuck.

---

## Prerequisites

- [OpenCode](https://opencode.ai) installed and run at least once.
- An [OpenRouter](https://openrouter.ai) API key (`sk-or-v1-...`) with access to `typesafe/jev-1.13`.

## Installation

```bash
npx @misaelcs/opencode-jev install
```

The installer will:
1. Add `"@misaelcs/opencode-jev"` to your `opencode.jsonc` plugin array.
2. Prompt for your OpenRouter API key.
3. Install the `Jev` agent definition to your OpenCode agent directory.

Restart OpenCode to apply the hook.

## Usage

**Enable the Orchestrator:** Press `Ctrl+O` in OpenCode and select the **Jev** agent.

**Disable:** Switch back to any other agent — the hook bypasses automatically.

### Web Control Panel
Manage your OpenRouter API Key, Small Model, and Strategic Planner visually:

```bash
npx @misaelcs/opencode-jev panel
# Opens http://localhost:3040
```
*Note on API Keys:* When you save the OpenRouter API Key via the panel, it is safely injected directly into your OS environment variables (`setx` on Windows, or `~/.bashrc` / `~/.zshrc` on Linux/macOS) and mapped securely as `{env:OPENROUTER_API_KEY}` in your config.

**Uninstall:**
```bash
npx @misaelcs/opencode-jev uninstall
```

## Routing Categories & Domains

JEV evaluates the context against core domains + your installed MCPs:

| Category | When used |
|---|---|
| `FS_READ` | Read files, explore directories, search codebase |
| `FS_WRITE` | Write, edit, or create source files |
| `OS_EXECUTION` | Run shell commands, scripts, containers |
| `WEB_AUTOMATION` | Browser control (Playwright), scraping, testing |
| `KNOWLEDGE_RETRIEVAL` | Obsidian, web search, documentation |
| `WORKFLOW_CONTROL` | TODOs, sub-agents, asking the user questions |
| `FINAL_ANSWER` | Prose-only responses, no tool needed |
| `MCP_*` | Dynamically generated based on your installed MCP servers |

## Debug Log

All hook activity, classifications, guardrail detections, failure escalations, and model swaps are logged to:
- **Windows:** `%APPDATA%\opencode\jev_debug.log`
- **Linux/macOS:** `~/.config/opencode/jev_debug.log`

Structured classifications (routing, guardrail, failure) are appended to `~/.config/opencode/jev_classifications.jsonl`.

## Resiliency Architecture

- **Fail-Safe Bypasses:** If JEV confidence falls below 60%, if the OpenRouter API goes offline, or if rate limits are hit, the plugin fails silently and transparently passes execution back to the Core LLM to maintain standard OpenCode behavior without disruption.
- **Fail-Open Guardrails:** If the guardrail check itself fails (network, timeout), the tool call proceeds. The guardrail never blocks silently due to infrastructure failure.
- **Conservative Skip-List:** The read-only skip-list only skips tools whose names are unambiguously reads. Anything ambiguous or compound is always checked by JEV.
- **Strict JSONC Parsing:** The plugin uses Microsoft's `jsonc-parser` to inject variables via AST without removing your custom comments, formatting, or breaking existing configuration files.

## License

MIT
