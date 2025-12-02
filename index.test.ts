import { describe, it, expect, beforeEach, afterEach, vi } from 'bun:test';
import type { PluginInput } from '@opencode-ai/plugin';
import type { Auth as ProviderAuth, Provider } from '@opencode-ai/sdk';
import type { GenerateContentResponse } from '@google/genai';
import type { GeminiSearchResult } from './index';

const mockGenerateContent = vi.fn();
const mockGoogleGenAI = vi.fn(() => ({
  models: {
    generateContent: mockGenerateContent,
  },
}));

void vi.mock('@google/genai', () => {
  return {
    GoogleGenAI: mockGoogleGenAI,
  };
});

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
  beforeEach(() => {
    mockGenerateContent.mockReset();
    mockGoogleGenAI.mockClear();
    process.env.GEMINI_API_KEY = 'test-key';
  });

  afterEach(() => {
    delete process.env.GEMINI_API_KEY;
  });

  it('returns configuration error when API key is missing', async () => {
    delete process.env.GEMINI_API_KEY;
    const plugin = await createPluginHooks();
    const tool = plugin.tool?.websearch_gemini;

    const context = createToolContext();

    const raw = await tool!.execute({ query: 'opencode' }, context);
    const result = parseResult(raw);

    expect(result.error?.type).toBe('MISSING_GEMINI_API_KEY');
    expect(result.llmContent).toContain('log in to the Google provider');
    expect(mockGenerateContent).not.toHaveBeenCalled();
  });

  it('returns successful search results', async () => {
    mockGenerateContent.mockResolvedValue(
      createResponse({
        content: {
          role: 'model',
          parts: [{ text: 'Search body' }],
        },
        groundingMetadata: {
          groundingChunks: [{ web: { title: 'Example', uri: 'https://example.com' } }],
          groundingSupports: [
            {
              segment: { startIndex: 0, endIndex: 6 },
              groundingChunkIndices: [0],
            },
          ],
        },
      })
    );

    const plugin = await createPluginHooks();
    const tool = plugin.tool?.websearch_gemini;
    const context = createToolContext();

    const raw = await tool!.execute({ query: 'sample' }, context);
    const result = parseResult(raw);

    expect(result.error).toBeUndefined();
    expect(result.llmContent).toContain('Web search results for "sample"');
    expect(result.sources).toBeDefined();
    expect(result.sources?.length).toBe(1);
  });

  it('returns Gemini failure details', async () => {
    mockGenerateContent.mockRejectedValue(new Error('API Failure'));

    const plugin = await createPluginHooks();
    const tool = plugin.tool?.websearch_gemini;
    const context = createToolContext();

    const raw = await tool!.execute({ query: 'sample' }, context);
    const result = parseResult(raw);

    expect(result.error?.type).toBe('GEMINI_WEB_SEARCH_FAILED');
    expect(result.llmContent).toContain('currently unavailable');
    expect(result.llmContent).toContain('API Failure');
  });

  it('prefers stored Google provider API key over environment variable', async () => {
    process.env.GEMINI_API_KEY = 'env-key';
    mockGenerateContent.mockResolvedValue(
      createResponse({
        content: {
          role: 'model',
          parts: [{ text: 'Stored key response' }],
        },
      })
    );

    const plugin = await createPluginHooks();
    await invokeAuthLoader(plugin, { type: 'api', key: 'stored-key' });

    const tool = plugin.tool?.websearch_gemini;
    const context = createToolContext();

    await tool!.execute({ query: 'stored key query' }, context);

    expect(mockGoogleGenAI).toHaveBeenCalledWith({ apiKey: 'stored-key' });
  });

  it('always requests the default Gemini model', async () => {
    mockGenerateContent.mockResolvedValue(
      createResponse({
        content: {
          role: 'model',
          parts: [{ text: 'Default model response' }],
        },
      })
    );

    const plugin = await createPluginHooks();
    const tool = plugin.tool?.websearch_gemini;
    const context = createToolContext();

    await tool!.execute({ query: 'model query' }, context);

    expect(mockGenerateContent).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'gemini-2.5-flash' })
    );
  });
});

type CandidateInput = NonNullable<GenerateContentResponse['candidates']>[number];

function parseResult(raw: string): GeminiSearchResult {
  return JSON.parse(raw) as unknown as GeminiSearchResult;
}

type PluginHooks = Awaited<ReturnType<typeof WebsearchGeminiPlugin>>;

async function createPluginHooks() {
  return WebsearchGeminiPlugin({} as PluginInput);
}

async function invokeAuthLoader(plugin: PluginHooks, auth?: ProviderAuth) {
  if (!plugin.auth?.loader) {
    return;
  }
  await plugin.auth.loader(() => Promise.resolve(auth as ProviderAuth), {} as Provider);
}

function createResponse(candidate: CandidateInput): GenerateContentResponse {
  return {
    candidates: [candidate],
  } as GenerateContentResponse;
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
