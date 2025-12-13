LLM-grounded web search plugin for [OpenCode](https://opencode.ai), with inline citations and a `Sources:` list when available.

This plugin exposes a web search capability as an OpenCode custom tool, so your agent can call a single tool to perform web search with inline citations.

---

## Features

- `websearch_cited` tool backed by the builtin web search tool from:
  - [Google](https://ai.google.dev/gemini-api/docs/google-search)
  - [OpenAI](https://platform.openai.com/docs/guides/tools-web-search)
  - [OpenRouter](https://openrouter.ai/docs/guides/features/plugins/web-search)
- Outputs results with inline citations and a `Sources:` list when available.

Example output (short):

```markdown
Answer with citations[1] based on web search results[2].

Sources:
[1] Example Source (https://example.test/source-1)
[2] Another Source (https://example.test/source-2)
```

Full example see [example_output.md](./example_output.md).

---

## Installation

Add `opencode-websearch-cited` to your `~/.config/opencode/opencode.json`.

**IMPORTANT**: Put `opencode-websearch-cited` LAST in the `plugin` list to avoid impacting other plugins' auth process.

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "...other plugins",
    "opencode-websearch-cited@1.0.2"
  ]
}
```

OpenCode does not upgrade plugins automatically, so you need to pin the version once the plugin upgraded.

As long as the plugin is enabled and the provider auth is configured, any OpenCode agent that can use tools will be able to call `websearch_cited` when it needs web search with citations.

---

## Configure web search

Log in with `opencode auth login` first.

This plugin is compatible with [opencode-openai-codex-auth](https://github.com/numman-ali/opencode-openai-codex-auth.git) and [opencode-gemini-auth](https://github.com/jenslys/opencode-gemini-auth)

Set a `websearch_cited` model in your OpenCode config (required)

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "openrouter": {
      "options": {
        "websearch_cited": {
          "model": "x-ai/grok-4.1-fast"
        }
      }
    },
    "openai": {
      "options": {
        "websearch_cited": {
          "model": "gpt-5.1"
        }
      }
    },
    "google": {
      "options": {
        "websearch_cited": {
          "model": "gemini-2.5-flash"
        }
      }
    }
  }
}
```

If you specify multiple `websearch_cited.models` fields in your `opencode.json`, the plugin scans `provider` entries in order and uses the first provider that contains `options.websearch_cited.model`. **The order matters**.

If auth or model config is missing, `websearch_cited` throws an error and OpenCode will display the message.

---

## Development

This repository uses Bun and TypeScript.

```bash
# Install dependencies
bun install

# Run tests after any change
bun test:agent
```

When testing the plugin against a globally installed `opencode` CLI during development, you can point OpenCode at a local checkout using a `file://` URL in your `opencode.jsonc`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["file:///path/to/opencode-websearch-cited/index.ts"]
}
```

Contributions and feedback are welcome.
