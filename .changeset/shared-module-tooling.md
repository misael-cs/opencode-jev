---
"@misaelcs/opencode-jev": patch
---

Dev experience: Biome + Vitest + typecheck pipeline, GitHub Actions CI (PR validation + Changesets release), and a shared module (`src/shared.ts`) that centralizes config paths and extracts the pure routing/heuristic core (guardrail skip-list, thresholds, harvester sampling, model-string parsing) with unit tests.