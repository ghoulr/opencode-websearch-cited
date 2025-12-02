# opencode-websearch-gemini

Gemini Web Search plugin for [OpenCode](https://opencode.ai), inspired by [Gemini CLI](https://github.com/google-gemini/gemini-cli).

This plugin exposes a Gemini-backed web search capability as an OpenCode custom tool, so your agent can call a single tool to perform google grounded web search.

---

## Features

- `websearch_gemini` tool backed by Google Gemini web search.
- Uses the official `@google/genai` SDK under the hood.
- Always calls the `gemini-2.5-flash` model with the `googleSearch` tool enabled.
- Outputs exact result with format of Gemini CLI.

For more details, see the design spec in `docs/spec.md`.

---

## How it works

- The plugin registers a custom tool named `websearch_gemini` with OpenCode.
- When an agent calls this tool with a `query`, the plugin:
  - Resolves a Gemini API key by first from `opencode auth login` and falling back to `GEMINI_API_KEY` env.
  - Uses `@google/genai` to call a Gemini model configured with the `googleSearch` tool.
  - Takes the returned answer text and grounding metadata.
  - Inserts citation markers into the text and builds a sources list.
  - Returns a markdown-formatted answer plus a structured `sources` array.

This mirrors the behavior of the Gemini CLI `WebSearchTool`, but packaged as a reusable OpenCode plugin.

From a user perspective:

- You ask your OpenCode agent a question that needs web context.
- The agent decides to call `websearch_gemini` with your natural-language query.
- Gemini performs a web search and returns an answer with inline citations and a numbered "Sources" list at the bottom.

---

## Installation

After installing the plugin from npm, enable it in your `opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-websearch-gemini"],
}
```

As long as the plugin is enabled and the Gemini API key is configured, any OpenCode agent that can use tools will be able to call `websearch_gemini` when it needs web search.

---

## Gemini API key

This plugin needs a Gemini API key and resolves it in this order:

1. **OpenCode auth store**: run `opencode auth login`, select the Google provider, and input your Gemini API key when prompted.
2. **Environment fallback**: if you prefer not to store the key, export it as `GEMINI_API_KEY`:

   ```bash
   export GEMINI_API_KEY="your-gemini-api-key"
   ```

If neither source is available, `websearch_gemini` returns a `MISSING_GEMINI_API_KEY` error instead of calling the Gemini API.

---

## Development

This repository uses Bun and TypeScript.

```bash
# Install dependencies
bun install

# Run tests after any change
bun test
```

When testing the plugin against a globally installed `opencode` CLI during development, you can point OpenCode at a local checkout using a `file://` URL in your `opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["file:///path/to/opencode-websearch-gemini/index.ts"],
}
```

Contributions and feedback are welcome.
