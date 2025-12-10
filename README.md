# opencode-websearch-gemini

LLM-grounded web search plugin for [OpenCode](https://opencode.ai), inspired by [Gemini CLI](https://github.com/google-gemini/gemini-cli).

This plugin exposes a Gemini-backed, LLM-grounded web search capability as an OpenCode custom tool, so your agent can call a single tool to perform Google-grounded web search with inline citations.

---

## Features

- `websearch_grounded` tool backed by Google Gemini web search over the official REST API.
- Uses the model configured at `provider.google.options.websearch_grounded.model` (with optional legacy support for `provider.google.options.websearch.model`) with the `googleSearch` tool enabled.
- Outputs LLM-grounded results with inline citations and a sources list, in a format similar to the Gemini CLI.

---

## How it works

- The plugin registers a custom tool named `websearch_grounded` with OpenCode.
- When an agent calls this tool with a `query`, the plugin:
  - Resolves a Gemini API key from the OpenCode Google provider auth (`opencode auth login`) or `GEMINI_API_KEY`.
  - Requires `provider.google.options.websearch_grounded.model` (or legacy `provider.google.options.websearch.model`) to be set in `opencode.json` and uses that model with the `googleSearch` tool.
  - Takes the returned answer text and grounding metadata.
  - Inserts citation markers into the text and builds a sources list.
  - Returns a markdown-formatted, LLM-grounded answer plus a structured `sources` array.

This mirrors the behavior of the Gemini CLI `WebSearchTool`, but packaged as an OpenCode plugin.

From a user perspective:

- You ask your OpenCode agent a question that needs web context.
- The agent decides to call `websearch_grounded` with your natural-language query.
- Gemini performs a web search and returns an LLM-grounded answer with inline citations and a numbered "Sources" list at the bottom.

---

## Installation

Add `opencode-websearch-gemini` to your `~/.config/opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-websearch-gemini@0.9.2"]
}
```

OpenCode does not upgrade plugins automatically, so you need to pin the version once the plugin upgraded.

As long as the plugin is enabled and the Gemini API key is configured, any OpenCode agent that can use tools will be able to call `websearch_grounded` when it needs LLM-grounded web search.

---

## Configure Gemini web search

1. Authenticate the Google provider with a Gemini API key:

   ```bash
   opencode auth login
   ```

2. Set a `websearch_grounded` model in your `opencode.json` (required):

   ```jsonc
   {
     "provider": {
       "google": {
         "options": {
           "websearch_grounded": {
             "model": "gemini-2.5-flash",
           },
         },
       },
     },
   }
   ```

If either the API key or the model is missing, `websearch_grounded` returns an error (`INVALID_AUTH` or `INVALID_MODEL`).

### OAuth support

This plugin only supports **API key based authentication** for Gemini. If you are using [opencode-gemini-auth](https://github.com/jenslys/opencode-gemini-auth), re-authenticating with `opencode auth login` will overwrite your OAuth token.

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

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["file:///path/to/opencode-websearch-gemini/index.ts"]
}
```

Contributions and feedback are welcome.
