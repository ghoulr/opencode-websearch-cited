import { describe, it, expect, beforeEach, afterEach, vi } from 'bun:test';
import type { PluginInput } from '@opencode-ai/plugin';
import type { Auth as ProviderAuth, Config, Provider } from '@opencode-ai/sdk';
import type { WebSearchResult } from './index';
import type { GeminiGenerateContentResponse } from './src/types.ts';

const WEBSEARCH_CONFIG: Config = {
  provider: {
    google: {
      options: {
        websearch_grounded: {
          model: 'gemini-2.5-flash',
        },
      },
    },
  },
};

const { formatWebSearchResponse, WebsearchGeminiPlugin } = await import('./index');

describe('formatWebSearchResponse', () => {
  it('returns fallback when Gemini response has no text', () => {
    const response = createResponse({
      content: {
        role: 'model',
        parts: [{ text: '' }],
      },
    });

    const result = formatWebSearchResponse(response, 'no results query');

    expect(result.llmContent).toBe(
      'No search results or information found for query: "no results query"'
    );
    expect(result.returnDisplay).toBe('No information found.');
    expect(result.sources).toBeUndefined();
  });

  it('formats results without sources', () => {
    const response = createResponse({
      content: {
        role: 'model',
        parts: [{ text: 'Here are your results.' }],
      },
    });

    const result = formatWebSearchResponse(response, 'successful query');

    expect(result.llmContent).toBe(
      'Web search results for "successful query":\n\nHere are your results.'
    );
    expect(result.returnDisplay).toBe(
      'Search results for "successful query" returned.'
    );
    expect(result.sources).toBeUndefined();
  });

  it('inserts citations and sources for grounding metadata', () => {
    const response = createResponse({
      content: {
        role: 'model',
        parts: [{ text: 'This is a test response.' }],
      },
      groundingMetadata: {
        groundingChunks: [
          { web: { uri: 'https://example.com', title: 'Example Site' } },
          { web: { uri: 'https://google.com', title: 'Google' } },
        ],
        groundingSupports: [
          {
            segment: { startIndex: 5, endIndex: 14 },
            groundingChunkIndices: [0],
          },
          {
            segment: { startIndex: 15, endIndex: 24 },
            groundingChunkIndices: [0, 1],
          },
        ],
      },
    });

    const result = formatWebSearchResponse(response, 'grounding query');

    expect(result.llmContent).toBe(
      'Web search results for "grounding query":\n\nThis is a test[1] response.[1][2]\n\nSources:\n[1] Example Site (https://example.com)\n[2] Google (https://google.com)'
    );
    expect(result.sources).toHaveLength(2);
  });

  it('respects UTF-8 byte indices for citation insertion', () => {
    const response = createResponse({
      content: {
        role: 'model',
        parts: [{ text: 'こんにちは! Gemini CLI✨️' }],
      },
      groundingMetadata: {
        groundingChunks: [
          {
            web: {
              title: 'Japanese Greeting',
              uri: 'https://example.test/japanese-greeting',
            },
          },
          {
            web: {
              title: 'google-gemini/gemini-cli',
              uri: 'https://github.com/google-gemini/gemini-cli',
            },
          },
          {
            web: {
              title: 'Gemini CLI: your open-source AI agent',
              uri: 'https://blog.google/technology/developers/introducing-gemini-cli-open-source-ai-agent/',
            },
          },
        ],
        groundingSupports: [
          {
            segment: { startIndex: 0, endIndex: 16 },
            groundingChunkIndices: [0],
          },
          {
            segment: { startIndex: 17, endIndex: 33 },
            groundingChunkIndices: [1, 2],
          },
        ],
      },
    });

    const result = formatWebSearchResponse(response, 'multibyte query');

    expect(result.llmContent).toBe(
      'Web search results for "multibyte query":\n\nこんにちは![1] Gemini CLI✨️[2][3]\n\nSources:\n[1] Japanese Greeting (https://example.test/japanese-greeting)\n[2] google-gemini/gemini-cli (https://github.com/google-gemini/gemini-cli)\n[3] Gemini CLI: your open-source AI agent (https://blog.google/technology/developers/introducing-gemini-cli-open-source-ai-agent/)'
    );
    expect(result.sources).toHaveLength(3);
  });
});

describe('WebsearchGeminiPlugin', () => {
  let warnSpy: ReturnType<typeof vi.spyOn<typeof console, 'warn'>>;
  let fetchMock: ReturnType<typeof vi.spyOn<typeof globalThis, 'fetch'>>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fetchMock = vi.spyOn(globalThis, 'fetch');
    fetchMock.mockRejectedValue(new Error('fetch mock not configured'));
  });

  afterEach(() => {
    warnSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it('returns configuration error when API key is missing', async () => {
    const plugin = await createPluginHooks(WEBSEARCH_CONFIG);
    const tool = plugin.tool?.websearch_grounded;

    const context = createToolContext();

    const raw = await tool!.execute({ query: 'opencode' }, context);
    const result = parseResult(raw);

    expect(result.error?.type).toBe('INVALID_AUTH');
    expect(result.llmContent).toContain('missing or invalid auth');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns invalid model when websearch model is not configured', async () => {
    const plugin = await createPluginHooks();
    const tool = plugin.tool?.websearch_grounded;
    const context = createToolContext();

    const raw = await tool!.execute({ query: 'opencode' }, context);
    const result = parseResult(raw);

    expect(result.error?.type).toBe('INVALID_MODEL');
    expect(result.llmContent).toContain('missing or invalid model');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns invalid model when configured model is blank', async () => {
    const plugin = await createPluginHooks({
      provider: {
        google: {
          options: {
            websearch_grounded: { model: '' },
          },
        },
      },
    } as Config);
    const tool = plugin.tool?.websearch_grounded;
    const context = createToolContext();

    const raw = await tool!.execute({ query: 'opencode' }, context);
    const result = parseResult(raw);

    expect(result.error?.type).toBe('INVALID_MODEL');
    expect(result.llmContent).toContain('missing or invalid model');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects extra arguments', async () => {
    const plugin = await createPluginHooks();
    const tool = plugin.tool?.websearch_grounded;
    const context = createToolContext();

    const raw = await tool!.execute(
      { query: 'sample', format: 'markdown' } as never,
      context
    );
    const result = parseResult(raw);

    expect(result.error?.type).toBe('INVALID_TOOL_ARGUMENTS');
    expect(result.llmContent).toContain(
      "Unknown argument(s): format, only 'query' supported"
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns successful search results', async () => {
    fetchMock.mockResolvedValueOnce(
      createFetchResponse(
        createResponse({
          content: {
            role: 'model',
            parts: [{ text: 'Search body' }],
          },
          groundingMetadata: {
            groundingChunks: [
              { web: { title: 'Example', uri: 'https://example.com' } },
            ],
            groundingSupports: [
              {
                segment: { startIndex: 0, endIndex: 6 },
                groundingChunkIndices: [0],
              },
            ],
          },
        })
      )
    );

    const plugin = await createPluginHooks(WEBSEARCH_CONFIG);
    await invokeAuthLoader(plugin, { type: 'api', key: 'stored-key' });
    const tool = plugin.tool?.websearch_grounded;
    const context = createToolContext();

    const raw = await tool!.execute({ query: 'sample' }, context);
    const result = parseResult(raw);

    expect(result.error).toBeUndefined();
    expect(result.llmContent).toContain('Web search results for "sample"');
    expect(result.sources).toBeDefined();
    expect(result.sources?.length).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns Gemini failure details', async () => {
    const failure = new Error('API Failure');
    fetchMock.mockRejectedValueOnce(failure);

    const plugin = await createPluginHooks(WEBSEARCH_CONFIG);
    await invokeAuthLoader(plugin, { type: 'api', key: 'stored-key' });
    const tool = plugin.tool?.websearch_grounded;
    const context = createToolContext();

    const raw = await tool!.execute({ query: 'sample' }, context);
    const result = parseResult(raw);

    expect(result.error?.type).toBe('GEMINI_WEB_SEARCH_FAILED');
    expect(result.llmContent).toContain('currently unavailable');
    expect(result.llmContent).toContain('API Failure');
    expect(warnSpy).toHaveBeenCalledWith('Gemini web search failed.', failure);
  });

  it('uses the API key from provider auth', async () => {
    fetchMock.mockResolvedValueOnce(
      createFetchResponse(
        createResponse({
          content: {
            role: 'model',
            parts: [{ text: 'Stored key response' }],
          },
        })
      )
    );

    const plugin = await createPluginHooks(WEBSEARCH_CONFIG);
    await invokeAuthLoader(plugin, { type: 'api', key: 'stored-key' });

    const tool = plugin.tool?.websearch_grounded;
    const context = createToolContext();

    await tool!.execute({ query: 'stored key query' }, context);

    const [, init] = fetchMock.mock.calls[0] ?? [];
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers['x-goog-api-key']).toBe('stored-key');
  });

  it('uses the configured model', async () => {
    fetchMock.mockResolvedValueOnce(
      createFetchResponse(
        createResponse({
          content: {
            role: 'model',
            parts: [{ text: 'Default model response' }],
          },
        })
      )
    );

    const plugin = await createPluginHooks({
      provider: {
        google: {
          options: {
            websearch_grounded: { model: 'gemini-custom-model' },
          },
        },
      },
    } as Config);
    await invokeAuthLoader(plugin, { type: 'api', key: 'stored-key' });
    const tool = plugin.tool?.websearch_grounded;
    const context = createToolContext();

    await tool!.execute({ query: 'model query' }, context);

    const [url] = fetchMock.mock.calls[0] ?? [];
    expect(typeof url === 'string' ? url : '').toContain('gemini-custom-model');
  });
});

type CandidateInput = NonNullable<GeminiGenerateContentResponse['candidates']>[number];

type PluginHooks = Awaited<ReturnType<typeof WebsearchGeminiPlugin>>;

function parseResult(raw: string): WebSearchResult {
  return JSON.parse(raw) as unknown as WebSearchResult;
}

async function createPluginHooks(config?: Config) {
  const plugin = await WebsearchGeminiPlugin({} as PluginInput);
  if (config && plugin.config) {
    await plugin.config(config);
  }
  return plugin;
}

async function invokeAuthLoader(plugin: PluginHooks, auth?: ProviderAuth) {
  if (!plugin.auth?.loader) {
    return;
  }
  await plugin.auth.loader(() => Promise.resolve(auth as ProviderAuth), {} as Provider);
}

function createResponse(candidate: CandidateInput): GeminiGenerateContentResponse {
  return {
    candidates: [candidate],
  };
}

function createFetchResponse(
  body: GeminiGenerateContentResponse,
  init?: Partial<Pick<Response, 'ok' | 'status' | 'statusText'>>
): Response {
  return {
    ok: init?.ok ?? true,
    status: init?.status ?? 200,
    statusText: init?.statusText ?? 'OK',
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as Response;
}

function createToolContext() {
  const controller = new AbortController();
  return {
    sessionID: 'session',
    messageID: 'message',
    agent: 'agent',
    abort: controller.signal,
  };
}
