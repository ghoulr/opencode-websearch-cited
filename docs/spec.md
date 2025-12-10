# Multi-provider Web Search Spec

This document defines a common interface and provider-specific behavior for web search tools backed by different providers:

- Google Gemini (current `websearch_gemini` implementation)
- OpenAI via OAuth (OpenAI Codex OAuth plugin)
- OpenRouter Responses API with web search plugin

The goal is to let OpenCode agents call a single-purpose tool per provider (or a future unified tool) and always receive a consistent, citation-friendly result structure.

---

## Goals

- Provide a **unified result shape** for all providers.
- Keep the **existing `websearch_gemini` behavior fully compatible**.
- Allow adding **OpenAI (OAuth)** and **OpenRouter** backed web search without changing callers.
- Make it explicit **which provider can return structured citations** and how they are derived.

Non-goals for this spec:

- Implement every provider in this repository right away.
- Define complex routing or automatic provider selection logic.

---

## Common Tool Contract

### Tool shape

Each provider-specific tool follows this logical contract (names may differ per provider):

- **Input** (args object):
  - `query: string` (required, non-empty after trimming)
- **Output** (JSON-serialised object):

  ```ts
  type WebSearchError = {
    message: string;
    type?: string;
  };

  type WebSourceWeb = {
    title?: string;
    uri?: string;
  };

  type WebSource = {
    web?: WebSourceWeb;
  };

  type WebSearchResult = {
    llmContent: string; // Markdown, user-facing answer
    returnDisplay: string; // Short status / summary string
    sources?: WebSource[]; // Optional structured sources
    error?: WebSearchError; // Optional error information
  };
  ```

- **Serialization**:
  - `execute` always returns `JSON.stringify(WebSearchResult)`.

### Argument validation

All provider tools enforce the same basic validation:

- Only accept keys defined in `WEBSEARCH_ARGS` (currently just `query`).
- Reject extra keys with an `INVALID_TOOL_ARGUMENTS` error.
- Reject empty or whitespace-only `query` with `INVALID_QUERY`.

Example error shape:

```ts
{
  llmContent: "Error: websearch_* only accepts a single 'query' field.\n\nDetails: Unknown argument(s): foo, only 'query' supported.",
  returnDisplay: "websearch_* only accepts a single 'query' field.",
  error: {
    message: "Unknown argument(s): foo, only 'query' supported.",
    type: "INVALID_TOOL_ARGUMENTS",
  },
}
```

### Auth and configuration

- The websearch tools **do not perform interactive auth flows themselves**.
- They rely on **OpenCode providers, provider options, and/or environment variables** to supply credentials and defaults.
- Each provider section below specifies:
  - Provider id (for OpenCode, when applicable)
  - How credentials are resolved
  - How `provider.<id>.options.websearch` is interpreted
  - Which env vars act as fallbacks

#### Provider options (`provider.*.options.websearch`)

- Opencode's main config file may define provider-specific websearch defaults, for example:

  ```jsonc
  {
    "provider": {
      "google": {
        "options": {
          "websearch": {
            "model": "gemini-2.5-flash",
          },
        },
      },
      "openai": {
        "options": {
          "websearch": {
            "model": "openai/gpt-5.1-codex",
          },
        },
      },
    },
  }
  ```

- Each provider section documents which keys are read from this `websearch` block.
- Unless otherwise stated, precedence is:
  - Tool arguments (none today) >
  - `provider.<id>.options.websearch` >
  - Internal hard-coded defaults.

---

## Gemini Provider (Google)

### Tool

- Name: `websearch_gemini`
- Description: performs web search via Google Gemini with the `googleSearch` tool.
- Provider id: `google`

### Auth resolution

1. Try OpenCode provider auth for `provider: "google"` (type `api` key).
2. Fallback to `process.env.GEMINI_API_KEY`.
3. If neither is available, return `MISSING_GEMINI_API_KEY` error.

Error shape:

```ts
error.type === 'MISSING_GEMINI_API_KEY';
```

### Underlying API call

- Transport: plain HTTP to the Gemini Generative Language API.
- Endpoint: `https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent`.
- Model:
  - Default is `gemini-2.5-flash`.
  - If `provider.google.options.websearch.model` is a non-empty string, that value overrides the default.
- Request headers (API-key based flow):
  - `x-goog-api-key: <GEMINI_API_KEY or provider api key>`
  - `Content-Type: application/json`
- Request body (simplified shape):

  ```jsonc
  {
    "contents": [
      {
        "role": "user",
        "parts": [{ "text": "<query>" }],
      },
    ],
    "tools": [{ "googleSearch": {} }],
  }
  ```

- The tool uses the Opencode tool context `abort` signal as the HTTP `AbortSignal`.

### Response mapping

- Text:
  - Extract concatenated, non-thought `part.text` from `response.candidates[0].content.parts`.
  - If empty/whitespace:
    - `llmContent = "No search results or information found for query: \"{query}\""`
    - `returnDisplay = "No information found."`
    - `sources` omitted.

- Citations (grounding metadata):
  - Read `response.candidates[0].groundingMetadata` as `GeminiMetadata`.
  - Use `groundingSupports` to get `segment.endIndex` (UTF-8 byte indices) and `groundingChunkIndices`.
  - For each support:
    - Build marker string from unique sorted indices: `"[1][2]"` etc.
    - Schedule insertion at `endIndex`.
  - Apply markers with a UTF-8-aware insertion routine.

- Sources:
  - Use `groundingChunks` array directly as `sources`.
  - For display, append at the end of `modifiedText`:

    ```text
    Sources:
    [1] Title 1 (https://example.com)
    [2] Title 2 (https://example.org)
    ```

- Final `WebSearchResult`:

  ```ts
  {
    llmContent: `Web search results for "${query}":\n\n${modifiedText}`,
    returnDisplay: `Search results for "${query}" returned.`,
    sources: groundingChunks?,
  }
  ```

### Error handling

- Network / API errors:
  - Catch thrown errors from `generateContent`.
  - Return `GEMINI_WEB_SEARCH_FAILED` with a user-facing message and an internal detail string.

---

## OpenAI Provider (OAuth via Codex plugin)

This provider uses the existing `opencode-openai-codex-auth` plugin to handle all OpenAI OAuth flows and request transformation.

### Role of the OAuth plugin

- Plugin: `opencode-openai-codex-auth`.
- Provider id: `openai`.
- Responsibilities:
  - Implement OAuth (PKCE, local callback server, token exchange, refresh).
  - Decode JWT, extract ChatGPT account id.
  - Integrate with Opencode's OpenAI provider by overriding the HTTP layer (`baseURL` and `fetch`) so that server-side LLM calls are sent to the ChatGPT Codex backend instead of the public Platform API.

The websearch plugin **does not** implement the OAuth dance itself. It reuses the tokens stored by this plugin (via `getAuth()`), but performs its own HTTP requests directly to the Codex backend rather than going through `@opencode-ai/sdk` or the Opencode client.

### Tool

- Proposed name: `websearch_openai_oauth`.
- Provider id: `openai`.
- Description: performs a web-backed search using an OpenAI / ChatGPT model accessible via OAuth.

### Auth resolution

- No API key in this plugin.
- Requires the user to:
  - Install and enable `opencode-openai-codex-auth`.
  - Authenticate with `provider: "openai"` using the OAuth method.
- The websearch plugin reads the stored OAuth record for `provider: "openai"` via `getAuth()` and uses the current `access` token as a bearer token for its HTTP requests.

### Configuration (`provider.openai.options.websearch`)

- Opencode config may define OpenAI websearch defaults under `provider.openai.options.websearch`.
- Supported keys (initially):
  - `model?: string` – Codex model identifier to use for websearch when defined.
- If this block is missing or invalid, the implementation falls back to an internal default Codex model.

If no valid OpenAI OAuth session is present, the tool should:

- Let the OpenAI provider / SDK surface its own error where possible, or
- Return an explicit error such as:

  ```ts
  error.type === 'MISSING_OPENAI_OAUTH_SESSION';
  ```

(Exact error naming can be finalized during implementation.)

### Underlying API call

- Transport: plain HTTP to the same ChatGPT Codex backend that `opencode-openai-codex-auth` targets.
- Auth header: `Authorization: Bearer <accessTokenFromAuth>`.
- Content-Type: `application/json`.
- Request body: follows the same logical shape as an OpenAI Responses API call, with the chosen Codex model and the user query as input. The exact endpoint path and any additional headers are shared with the Codex OAuth plugin's request helpers.
- The websearch plugin does **not** use `@opencode-ai/sdk` or `client.responses.create` for this call; it constructs JSON and issues an HTTP `fetch` directly.

Notes:

- The Codex backend may already have browsing / web access features baked in, but does **not** expose a structured `groundingMetadata` equivalent.
- For this reason, the initial `websearch_openai_oauth` design treats OpenAI responses as **non-grounded text**.

### Response mapping

- Extract primary answer text using the OpenAI Responses API abstraction (`response.output_text` or equivalent first message content).
- No structured citations are expected, unless a future prompt/schema explicitly encodes them.

Initial mapping:

```ts
{
  llmContent: `Web search results for "${query}":\n\n${answerText}`,
  returnDisplay: `Search results for "${query}" returned.`,
  // sources is omitted by default for OAuth OpenAI
}
```

Optional future enhancement (not in this spec):

- Constrain the model with a JSON schema to return `{ answer, sources }` and synthesize a `sources` array, or
- Ask the model to embed inline `[1][2]` style citations and post-process URLs.

### Error handling

- Network / backend errors from the Codex HTTP call are surfaced as failures.
- The tool wraps them into `WebSearchResult.error` with an implementation-specific type, e.g. `OPENAI_OAUTH_WEB_SEARCH_FAILED`.

---

## OpenRouter Provider (Responses API + Web Plugin)

OpenRouter provides a Responses API that is broadly compatible with OpenAI's Responses API, plus a `web` plugin that adds real-time web search and structured URL citations.

### Tool

- Proposed name: `websearch_openrouter`.
- No fixed provider id in OpenCode yet; the plugin will handle HTTP directly.
- Description: performs web search via OpenRouter Responses API using the `web` plugin.

### Auth resolution

- Primary: `process.env.OPENROUTER_API_KEY`.
- Optionally, a future OpenCode provider for OpenRouter could inject credentials via `auth.loader`, but this spec assumes simple env-based configuration.

If no key is available, return a configuration error such as:

```ts
error.type === 'MISSING_OPENROUTER_API_KEY';
```

### Underlying API call

- Endpoint: `https://openrouter.ai/api/v1/responses`.
- Auth header: `Authorization: Bearer ${OPENROUTER_API_KEY}`.
- Content-Type: `application/json`.
- Basic request body for simple queries:

  ```json
  {
    "model": "openai/o4-mini", // or another supported model
    "input": "What is OpenRouter?",
    "plugins": [{ "id": "web", "max_results": 3 }],
    "max_output_tokens": 9000
  }
  ```

- For more complex cases, structured `input` arrays with `type: "message"` and `type: "input_text"` can be used, but the initial websearch tool can start with the simple string form.

### Response structure (OpenRouter)

Relevant fields from the response:

- `output`: array of items; we care about the first item with `type: "message"`.
- `content`: array within that message; we care about the first entry with `type: "output_text"`.
- `text`: the full generated answer.
- `annotations`: optional array containing citation metadata.

Each URL citation annotation has the shape:

```json
{
  "type": "url_citation",
  "url": "https://example.com/article",
  "start_index": 0,
  "end_index": 50
}
```

`start_index` and `end_index` are indices into the `text` string.

### Citations and sources mapping

- Extract the primary `output_text.text` string.
- Collect all annotations with `type === "url_citation"`.
- Deduplicate by URL and/or span as desired.

Two options for integrating them into the final answer text:

1. **Inline markers only**
   - For each citation, assign a numeric index based on deduplicated order.
   - Insert `[n]` markers into `text` at `end_index` positions.
   - This is similar to the Gemini `groundingSupports` approach, but uses character indices rather than UTF-8 byte offsets.

2. **Inline markers + Sources list (recommended)**
   - Same as (1) for inline `[n]` markers.
   - Build a `sources` array where each entry encodes `{ web: { title?: string; uri?: string } }`.
   - If OpenRouter does not provide titles, the `title` field may be omitted or use a placeholder (e.g. domain or path extracted from the URL).
   - Append a `Sources:` section to the end of the answer text, mirroring the Gemini format:

     ```text
     Sources:
     [1] Example (https://example.com)
     [2] Another Site (https://another.example)
     ```

### Final WebSearchResult mapping

```ts
{
  llmContent: `Web search results for "${query}":\n\n${modifiedTextWithMarkersAndSources}`,
  returnDisplay: `Search results for "${query}" returned.`,
  sources: derivedSourcesArray,
}
```

### Error handling

- HTTP error status from OpenRouter should be propagated as a failure.
- The tool wraps the failure into `WebSearchResult.error` with a type like `OPENROUTER_WEB_SEARCH_FAILED` and includes any useful error message or response body snippet in `error.message`.

---

## Provider Comparison

### Capabilities

- **Gemini**
  - Native `googleSearch` tool.
  - Rich grounding metadata with explicit chunk indices and byte-based spans.
  - Strong citation support; tight integration with Google Search.

- **OpenAI (OAuth / Codex)**
  - Uses ChatGPT backend via OAuth, not Platform API keys.
  - Can provide up-to-date answers depending on ChatGPT capabilities.
  - No public, structured grounding metadata; treated as non-grounded text in this spec.

- **OpenRouter**
  - Responses API compatible with OpenAI pattern.
  - `web` plugin adds web search functionality.
  - Provides URL citation annotations with character-based spans.

### Result consistency

All providers conform to the same `WebSearchResult` shape:

- `llmContent`: human-readable markdown answer, prefixed with `Web search results for "{query}":`.
- `returnDisplay`: short status message.
- `sources`: optional, populated when the provider exposes structured citation information (Gemini, OpenRouter).
- `error`: optional error info with at least `message` and `type`.

---

## Future Extensions

- A unified `websearch` tool that accepts a `provider` argument (e.g. `"gemini" | "openai_oauth" | "openrouter"`) and internally dispatches to the appropriate implementation.
- Structured output contracts for OpenAI OAuth-backed models to synthesize a `sources` array.
- Additional providers (e.g. Anthropic, other search APIs) that map into the same `WebSearchResult` contract.
