# State Memory & Context Basket

As an agent operating inside a long loop, you will lose track of older messages as the conversation grows.
To prevent context loss, you have a persistent memory basket that is injected into your system prompt on every turn.

## Updating your Memory

Whenever you finish a significant milestone or learn an important detail, you MUST update your memory context.

```bash
npx opencode-jev context "Update: 1. DB string is in src/config.ts. 2. Currently debugging auth failing on line 45."
```

- This command overwrites your current memory state.
- Keep it concise. Use it as a scratchpad or index (e.g. "To see the user's original schema, look at Message #2").
- When you receive your next turn, you will see `[JEV CONTEXT BASKET]` in your system prompt containing exactly what you wrote.

By actively maintaining your own memory, you become immune to context-window sliding and amnesia.