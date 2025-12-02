# opencode-websearch-gemini: Design Specification

## 1. Overview

`opencode-websearch-gemini` is an OpenCode plugin that exposes a Gemini-backed web search capability as a custom tool.

- The plugin provides a single primary tool, `websearch_gemini`.
- The tool sends the user query to Google Gemini using the official `@google/genai` SDK.
- Under the hood it uses a Gemini model configured with the `googleSearch` tool to perform web search.
- The tool returns a markdown-formatted answer that includes inline citations and a sources list, similar to the behavior of the Gemini CLI `WebSearchTool`.
- The plugin is model-agnostic on the OpenCode side: any provider/model used by OpenCode can call this tool.

The goal is to: "Bring Gemini CLI style web search into OpenCode as a first-class custom tool" without requiring users to change their primary model.

## 2. Goals and Non-goals

### 2.1 Goals

- Provide a reusable `websearch_gemini` tool within OpenCode that performs real web search via Gemini.
- Reuse a single Gemini API key between OpenCode and this plugin by reading OpenCodes stored Google provider credential first and falling back to environment variables.
- Match the user-facing behavior of the Gemini CLI `WebSearchTool` as closely as reasonable:
  - Use Geminis web search capability (`googleSearch` tool).
  - Insert citation markers (`[1]`, `[2]`, ...) into the answer text based on grounding metadata.
  - Append a "Sources" list with titles and URLs.
- Keep the implementation small and focused (KISS): one plugin, one primary tool, minimal configuration.

### 2.2 Non-goals

- Do not implement a general-purpose search aggregation layer or support arbitrary search providers.
- Do not re-implement the entire Gemini CLI or its configuration system.
- Do not modify OpenCode core; the plugin should work as a normal third-party plugin.

## 3. Architecture

### 3.1 High-level flow

1. The OpenCode agent decides to call the `websearch_gemini` tool with a query string.
2. OpenCode invokes the plugin tool handler.
3. The plugin resolves the Gemini API key in priority order:
   1. OpenCodes stored credential for the `google` provider (populated via `opencode auth login`).
   2. The `GEMINI_API_KEY` environment variable.
      If no key can be resolved, the tool returns an error and does not call Gemini.
4. The plugin constructs a `@google/genai` client with this API key.
5. The plugin calls a Gemini generative model configured with the `googleSearch` tool enabled.
6. Gemini performs web search and returns:
   - Answer text in `candidates[0].content.parts`.
   - Grounding metadata (`groundingChunks`, `groundingSupports`) that contains URLs, titles, and byte offsets.
7. The plugin post-processes the response:
   - Inserts citation markers into the answer text at the correct byte positions.
   - Builds a "Sources" section listing each source URL and title.
8. The plugin returns a structured result back to OpenCode, which is then presented to the user and/or used by the calling model.

### 3.2 Components

- **Plugin entry point (`index.ts`)**
  - Exports a `Plugin` typed function (from `@opencode-ai/plugin`).
  - Registers an auth hook for the Google provider so it can read the stored API key without modifying login flows.
  - Registers the `websearch_gemini` custom tool.
  - Does not perform any work at module load time besides lightweight initialization.

- **Gemini Web Search client**
  - A small internal module that:
    - Reads the Gemini API key from the environment.
    - Creates a `GoogleGenerativeAI` client (`@google/genai`).
    - Creates a generative model configured for web search.
    - Issues a request for a given query.
    - Returns the raw `GenerateContentResponse`.

- **Response formatter**
  - A pure utility responsible for turning `GenerateContentResponse` into the final result structure:
    - Extracts answer text from `candidates[0].content.parts`.
    - Extracts `groundingChunks` and `groundingSupports` from `groundingMetadata`.
    - Inserts citation markers into text using UTF-8 byte indices (mirroring `web-search.ts`).
    - Builds a structured `sources` array.
    - Produces a final markdown string.

The architecture deliberately avoids pulling in the full Gemini CLI core. Instead, it mirrors only the necessary logic from `web-search.ts` at a small scale.

## 4. `websearch_gemini` Tool Contract

### 4.1 Tool name and description

- **Name**: `websearch_gemini`
- **Description** (mirrored from Gemini CLI `WebSearchTool` where possible):

  > Performs a web search using Google Search (via the Gemini API) and returns the results. This tool is useful for finding information on the internet based on a query.

This description should be used in the plugin so that the calling model clearly understands the purpose of the tool.

### 4.2 Input arguments

The tool accepts a single required argument:

- `query: string`
  - The natural-language search query.
  - Must be non-empty and not just whitespace.

Validation rules:

- If `query` is missing or only whitespace:
  - The tool should return a validation error (do not attempt a Gemini call).

### 4.3 Output shape

Logically, the tool produces three things:

- A markdown-formatted answer that:
  - Starts with `Web search results for "<query>":`.
  - Includes inline citation markers (for example `[1]`, `[2]`) based on grounding metadata.
  - Optionally ends with a `Sources:` section listing numbered sources.
- A structured list of sources derived from `groundingMetadata.groundingChunks`.
- An optional error object if the request cannot be fulfilled.

In the current implementation, this is surfaced at the plugin boundary as a JSON stringified object with the following fields:

- `llmContent: string`
  - The markdown-formatted answer, including the prefix, inline citations, and optional `Sources:` section.
- `returnDisplay: string`
  - A short, user-facing summary of the result.
- `sources?: GroundingChunk[]`
  - Optional. Present when Gemini returns `groundingMetadata.groundingChunks`.
  - Each entry typically has `web.title` and `web.uri`.
- `error?: { message: string; type?: string }`
  - Optional error object.
  - When present, `llmContent` contains a human-readable explanation consistent with `error.message`.

Agents that only need text can use `llmContent` directly. Agents that need structured information can parse the JSON, inspect `sources`, and branch on `error.type` when present.

## 5. Gemini Request Details

### 5.1 Model and tools

To match the Gemini CLI `WebSearchTool` behavior, the initial implementation always:

- Uses the `gemini-2.5-flash` model.
- Enables the `googleSearch` tool.

In `@google/genai`, this looks like:

```ts
const genAI = new GoogleGenerativeAI(apiKey);
const model = genAI.getGenerativeModel({
  model: 'gemini-2.5-flash',
  tools: [{ googleSearch: {} }],
});
```

The request should send the user query as a single user message:

```ts
const res = await model.generateContent([{ role: 'user', parts: [{ text: query }] }]);
```

### 5.2 Response handling

The plugin should:

1. Extract text:
   - Traverse `res.candidates[0].content.parts` and concatenate all `part.text` values.
2. Extract grounding metadata:
   - `const gm = res.candidates?.[0]?.groundingMetadata`.
   - `gm.groundingChunks`: array of items, with optional `web: { uri?: string; title?: string }`.
   - `gm.groundingSupports`: each support has `segment.startIndex/endIndex` (byte positions) and `groundingChunkIndices`.
3. Insert citation markers:
   - For each support, build a marker string like `[1]` or `[1][2]` from `groundingChunkIndices`.
   - Use UTF-8 byte indices to place markers into the answer text.
   - Apply insertions in descending index order to avoid shifting.
4. Build sources array:
   - For each `groundingChunk`, extract `{ title, uri }` from `chunk.web`.
5. Construct final markdown string:
   - Prefix: `Web search results for "<query>":`.
   - Body: the modified answer text with inline citations.
   - Optional suffix: a `Sources:` section listing numbered sources.

If there is no answer text or only whitespace, return a friendly message indicating that no information was found for the query.

## 6. Configuration and Usage

### 6.1 Dependencies

Runtime dependencies:

- `@google/genai` 91.30.0 or later
- `@opencode-ai/sdk` 1.0.125 or later

The plugin is designed to run under Bun with ESM and TypeScript.

### 6.2 Environment variables

- `GEMINI_API_KEY` (final name can be adjusted later)
  - Used as a fallback when OpenCodes stored Google credential does not contain an API key.
  - Should be set to a valid Gemini API key if the user prefers not to store it via `opencode auth login`.

When neither a stored credential nor the environment variable is available, the tool should not attempt a network call and should instead return a clear error in the output.

### 6.3 OpenCode configuration

In `opencode.jsonc`, users are expected to:

- Enable the plugin:

  ```jsonc
  {
    "$schema": "https://opencode.ai/config.json",
    "plugin": ["opencode-websearch-gemini"],
  }
  ```

Once configured, any agent that has access to tools will be able to call `websearch_gemini` when it needs web search.

After enabling the plugin, users complete setup by running `opencode auth login`, selecting the Google provider, and entering their Gemini API key. The credential is stored by OpenCode and will be reused by this plugin. Using `GEMINI_API_KEY` is optional and only needed if users choose not to store the key via the auth workflow.

## 7. Error Handling and Limits

### 7.1 Validation errors

- Empty `query`:
  - Return an error with `code = "INVALID_QUERY"` and a descriptive message.

### 7.2 Network / API errors

- If the call to Gemini fails (network error, invalid key, quota exceeded, etc.):
  - Return an error with `code = "GEMINI_WEB_SEARCH_FAILED"`.
  - `text` should briefly describe that web search is currently unavailable and suggest checking configuration.

### 7.3 Safety

- The plugin does not add any extra safety logic beyond what Gemini already enforces.
- Any safety-related behavior is controlled by Geminis own safety settings and policies.

### 7.4 Timeouts

- The plugin should respect OpenCodes default tool timeout behavior (no custom long-running loops).
- If needed, a conservative per-request timeout can be added around the `generateContent` call.

## 8. Future Extensions

Potential future enhancements (out of scope for the initial version):

- Support specifying language or region preferences as optional tool arguments.
- Support limiting the maximum number of sources returned.
- Support an option to return the raw Gemini `groundingMetadata` in a separate field for advanced agents.
- Add minimal tests around the response formatter (especially the UTF-8 citation insertion logic).

The initial implementation should focus strictly on the core web search flow and a solid, predictable tool contract.
