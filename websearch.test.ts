import { describe, it, expect, beforeEach, afterEach, vi } from 'bun:test';
import type { Plugin, PluginInput } from '@opencode-ai/plugin';
import type { Auth as ProviderAuth, Config, Provider } from '@opencode-ai/sdk';

import { formatWebSearchResponse } from './src/google.ts';

const WEBSEARCH_CONFIG: Config = {
  provider: {
    google: {
      options: {
        websearch_cited: {
          model: 'gemini-2.5-flash',
        },
      },
    },
  },
};

let importCounter = 0;

type WebSearchGenerateContentResponse = Parameters<typeof formatWebSearchResponse>[0];

describe('formatWebSearchResponse', () => {
  it('returns fallback when response has no text', () => {
    const response = createResponse({
      content: {
        role: 'model',
        parts: [{ text: '' }],
      },
    });

    const result = formatWebSearchResponse(response, 'no results query');

    expect(result).toBe(
      'No search results or information found for query: "no results query"'
    );
  });

  it('formats results without sources', () => {
    const response = createResponse({
      content: {
        role: 'model',
        parts: [{ text: 'Here are your results.' }],
      },
    });

    const result = formatWebSearchResponse(response, 'successful query');

    expect(result).toBe('Here are your results.');
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

    expect(result).toBe(
      'This is a test[1] response.[1][2]\n\nSources:\n[1] Example Site (https://example.com)\n[2] Google (https://google.com)'
    );
  });

  it('respects UTF-8 byte indices for citation insertion', () => {
    const response = createResponse({
      content: {
        role: 'model',
        parts: [{ text: 'こんにちは! Web Search✨️' }],
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
              title: 'Example Repo',
              uri: 'https://example.test/repo',
            },
          },
          {
            web: {
              title: 'Example Article',
              uri: 'https://example.test/article',
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

    expect(result).toBe(
      'こんにちは![1] Web Search✨️[2][3]\n\nSources:\n[1] Japanese Greeting (https://example.test/japanese-greeting)\n[2] Example Repo (https://example.test/repo)\n[3] Example Article (https://example.test/article)'
    );
  });
});

describe('WebsearchCitedPlugin', () => {
  let fetchMock: ReturnType<typeof vi.spyOn<typeof globalThis, 'fetch'>>;

  beforeEach(() => {
    fetchMock = vi.spyOn(globalThis, 'fetch');
    fetchMock.mockRejectedValue(new Error('fetch mock not configured'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns configuration error when API key is missing', async () => {
    const { tool } = await createEnv(WEBSEARCH_CONFIG);

    const context = createToolContext();

    await expectThrowMessage(
      () => tool.execute({ query: 'opencode' }, context),
      'Missing auth for provider "google"'
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns invalid model when websearch model is not configured', async () => {
    const { tool } = await createEnv();
    const context = createToolContext();

    await expectThrowMessage(
      () => tool.execute({ query: 'opencode' }, context),
      'Missing web search model configuration'
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns invalid model when configured model is blank', async () => {
    const { tool } = await createEnv({
      provider: {
        google: {
          options: {
            websearch_cited: { model: '' },
          },
        },
      },
    } as Config);
    const context = createToolContext();

    await expectThrowMessage(
      () => tool.execute({ query: 'opencode' }, context),
      'Missing websearch_cited model for provider "google"'
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not fail init when config has no websearch model', async () => {
    const { tool } = await createEnv({
      provider: {
        google: {},
      },
    } as Config);
    const context = createToolContext();

    await expectThrowMessage(
      () => tool.execute({ query: 'opencode' }, context),
      'Missing web search model configuration'
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('skips invalid provider configs and uses the first valid one', async () => {
    const { tool } = await createEnv({
      provider: {
        openai: {
          options: {
            websearch_cited: { model: '' },
          },
        },
        google: {
          options: {
            websearch_cited: { model: 'gemini-2.5-flash' },
          },
        },
      },
    } as Config);
    const context = createToolContext();

    await expectThrowMessage(
      () => tool.execute({ query: 'opencode' }, context),
      'Missing auth for provider "google"'
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects extra arguments', async () => {
    const { tool } = await createEnv();
    const context = createToolContext();

    await expectThrowMessage(
      () => tool.execute({ query: 'sample', format: 'markdown' } as never, context),
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

    const { hooks, tool } = await createEnv(WEBSEARCH_CONFIG);
    await invokeAuthLoader(hooks, 'google', { type: 'api', key: 'stored-key' });
    const context = createToolContext();

    const result = await tool.execute({ query: 'sample' }, context);

    expect(result).toContain('Search');
    expect(result).toContain('Sources:\n[1] Example (https://example.com)');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns provider failure details', async () => {
    const failure = new Error('API Failure');
    fetchMock.mockRejectedValueOnce(failure);

    const { hooks, tool } = await createEnv(WEBSEARCH_CONFIG);
    await invokeAuthLoader(hooks, 'google', { type: 'api', key: 'stored-key' });
    const context = createToolContext();

    try {
      await tool.execute({ query: 'sample' }, context);
      throw new Error('Expected execute to throw');
    } catch (error) {
      expect(error).toBe(failure);
    }
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

    const { hooks, tool } = await createEnv(WEBSEARCH_CONFIG);
    await invokeAuthLoader(hooks, 'google', { type: 'api', key: 'stored-key' });
    const context = createToolContext();

    await tool.execute({ query: 'stored key query' }, context);

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

    const { hooks, tool } = await createEnv({
      provider: {
        google: {
          options: {
            websearch_cited: { model: 'gemini-custom-model' },
          },
        },
      },
    } as Config);
    await invokeAuthLoader(hooks, 'google', { type: 'api', key: 'stored-key' });
    const context = createToolContext();

    await tool.execute({ query: 'model query' }, context);

    const [url] = fetchMock.mock.calls[0] ?? [];
    expect(typeof url === 'string' ? url : '').toContain('gemini-custom-model');
  });

  it('uses Code Assist endpoint and project when Google OAuth is present', async () => {
    fetchMock.mockResolvedValueOnce(
      createFetchResponse({
        response: createResponse({
          content: {
            role: 'model',
            parts: [{ text: 'OAuth response' }],
          },
        }),
      })
    );

    const { hooks, tool } = await createEnv(WEBSEARCH_CONFIG);
    await invokeAuthLoader(hooks, 'google', {
      type: 'oauth',
      access: 'test-access-token',
      refresh: 'test-refresh|user-project|managed-project',
      expires: Date.now() + 120_000,
    });
    const context = createToolContext();

    const result = await tool.execute({ query: 'oauth query' }, context);

    expect(result).toContain('OAuth response');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(typeof url === 'string' ? url : '').toContain(
      'https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:generateContent'
    );

    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer test-access-token');

    const bodyText = typeof init?.body === 'string' ? init.body : '';
    const parsed = JSON.parse(bodyText) as Record<string, unknown>;
    expect(parsed.project).toBe('managed-project');
    expect(parsed.model).toBe('gemini-2.5-flash');

    const request = parsed.request;
    expect(request && typeof request === 'object').toBe(true);
  });

  it('prefers managedProjectId over projectId for Google OAuth', async () => {
    fetchMock.mockResolvedValueOnce(
      createFetchResponse({
        response: createResponse({
          content: {
            role: 'model',
            parts: [{ text: 'OAuth project preference' }],
          },
        }),
      })
    );

    const { hooks, tool } = await createEnv(WEBSEARCH_CONFIG);
    await invokeAuthLoader(hooks, 'google', {
      type: 'oauth',
      access: 'test-access-token',
      refresh: 'refresh-token-project|user-project|managed-project',
      expires: Date.now() + 120_000,
    });
    const context = createToolContext();

    await tool.execute({ query: 'oauth query' }, context);

    const [, init] = fetchMock.mock.calls[0] ?? [];
    const bodyText = typeof init?.body === 'string' ? init.body : '';
    const parsed = JSON.parse(bodyText) as Record<string, unknown>;
    expect(parsed.project).toBe('managed-project');
  });

  it('uses managedProjectId when projectId is empty for Google OAuth', async () => {
    fetchMock.mockResolvedValueOnce(
      createFetchResponse({
        response: createResponse({
          content: {
            role: 'model',
            parts: [{ text: 'OAuth managed project fallback' }],
          },
        }),
      })
    );

    const { hooks, tool } = await createEnv(WEBSEARCH_CONFIG);
    await invokeAuthLoader(hooks, 'google', {
      type: 'oauth',
      access: 'test-access-token',
      refresh: 'refresh-token-managed||managed-project',
      expires: Date.now() + 120_000,
    });
    const context = createToolContext();

    await tool.execute({ query: 'oauth query' }, context);

    const [, init] = fetchMock.mock.calls[0] ?? [];
    const bodyText = typeof init?.body === 'string' ? init.body : '';
    const parsed = JSON.parse(bodyText) as Record<string, unknown>;
    expect(parsed.project).toBe('managed-project');
  });

  it('falls back to loadCodeAssist when project metadata is missing', async () => {
    fetchMock
      .mockResolvedValueOnce(
        createFetchResponse({ cloudaicompanionProject: 'load-project' })
      )
      .mockResolvedValueOnce(
        createFetchResponse({
          response: createResponse({
            content: {
              role: 'model',
              parts: [{ text: 'Fallback project response' }],
            },
          }),
        })
      );

    const { hooks, tool } = await createEnv(WEBSEARCH_CONFIG);
    await invokeAuthLoader(hooks, 'google', {
      type: 'oauth',
      access: 'test-access-token',
      refresh: 'refresh-token-load',
      expires: Date.now() + 120_000,
    });

    const context = createToolContext();

    const result = await tool.execute({ query: 'oauth query' }, context);

    expect(result).toContain('Fallback project response');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [loadUrl, loadInit] = fetchMock.mock.calls[0] ?? [];
    expect(typeof loadUrl === 'string' ? loadUrl : '').toContain(
      'https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist'
    );
    const loadHeaders = (loadInit?.headers ?? {}) as Record<string, string>;
    expect(loadHeaders.Authorization).toBe('Bearer test-access-token');

    const [url, init] = fetchMock.mock.calls[1] ?? [];
    expect(typeof url === 'string' ? url : '').toContain(
      'https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:generateContent'
    );
    const bodyText = typeof init?.body === 'string' ? init.body : '';
    const parsed = JSON.parse(bodyText) as Record<string, unknown>;
    expect(parsed.project).toBe('load-project');
  });

  it('refreshes expired OAuth access token and uses it', async () => {
    fetchMock
      .mockResolvedValueOnce(
        createFetchResponse({ access_token: 'new-access', expires_in: 3600 })
      )
      .mockResolvedValueOnce(createFetchResponse({}))
      .mockResolvedValueOnce(
        createFetchResponse({
          response: createResponse({
            content: { role: 'model', parts: [{ text: 'Refreshed response' }] },
          }),
        })
      );

    const { hooks, tool } = await createEnv(WEBSEARCH_CONFIG);
    await invokeAuthLoader(hooks, 'google', {
      type: 'oauth',
      access: 'stale-access',
      refresh: 'refresh-token-expired|project-id|',
      expires: Date.now() - 1,
    });

    const context = createToolContext();

    const result = await tool.execute({ query: 'oauth query' }, context);

    expect(result).toContain('Refreshed response');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const [tokenUrl, tokenInit] = fetchMock.mock.calls[0] ?? [];
    expect(typeof tokenUrl === 'string' ? tokenUrl : '').toContain(
      'https://oauth2.googleapis.com/token'
    );
    const tokenBodyValue = tokenInit?.body;
    const tokenBody =
      tokenBodyValue instanceof URLSearchParams
        ? tokenBodyValue
        : new URLSearchParams(tokenBodyValue as string);
    expect(tokenBody.get('refresh_token')).toBe('refresh-token-expired');

    const [loadUrl] = fetchMock.mock.calls[1] ?? [];
    expect(typeof loadUrl === 'string' ? loadUrl : '').toContain(
      'https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist'
    );

    const [, generateInit] = fetchMock.mock.calls[2] ?? [];
    const headers = (generateInit?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer new-access');
  });

  it('refreshes when expires is missing', async () => {
    fetchMock
      .mockResolvedValueOnce(
        createFetchResponse({ access_token: 'new-access', expires_in: 3600 })
      )
      .mockResolvedValueOnce(createFetchResponse({}))
      .mockResolvedValueOnce(
        createFetchResponse({
          response: createResponse({
            content: { role: 'model', parts: [{ text: 'Refreshed response' }] },
          }),
        })
      );

    const { hooks, tool } = await createEnv(WEBSEARCH_CONFIG);
    await invokeAuthLoader(hooks, 'google', {
      type: 'oauth',
      access: 'stale-access',
      refresh: 'refresh-token-retry|project-id|',
      expires: Number.NaN,
    });

    const context = createToolContext();

    const result = await tool.execute({ query: 'oauth query' }, context);

    expect(result).toContain('Refreshed response');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const tokenCall = fetchMock.mock.calls[0];
    const tokenUrl = tokenCall?.[0];
    expect(typeof tokenUrl === 'string' ? tokenUrl : '').toContain(
      'https://oauth2.googleapis.com/token'
    );
    const [loadUrl] = fetchMock.mock.calls[1] ?? [];
    expect(typeof loadUrl === 'string' ? loadUrl : '').toContain(
      'https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist'
    );
    const retryHeaders = (fetchMock.mock.calls[2]?.[1]?.headers ?? {}) as Record<
      string,
      string
    >;
    expect(retryHeaders.Authorization).toBe('Bearer new-access');
  });

  it('throws when refresh fails', async () => {
    fetchMock.mockResolvedValueOnce(
      createFetchResponse(
        { error: { message: 'invalid_client' } },
        { ok: false, status: 400, statusText: 'Bad Request' }
      )
    );

    const { hooks, tool } = await createEnv(WEBSEARCH_CONFIG);
    await invokeAuthLoader(hooks, 'google', {
      type: 'oauth',
      access: '',
      refresh: 'refresh-token-fail|project-id|',
      expires: Date.now() + 120_000,
    });

    const context = createToolContext();

    await expectThrowMessage(
      () => tool.execute({ query: 'oauth query' }, context),
      'invalid_client'
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [callUrl] = fetchMock.mock.calls[0] ?? [];
    expect(typeof callUrl === 'string' ? callUrl : '').toContain(
      'https://oauth2.googleapis.com/token'
    );
  });

  it('reuses cached refreshed token within same module instance', async () => {
    fetchMock
      .mockResolvedValueOnce(
        createFetchResponse({ access_token: 'cached-access', expires_in: 3600 })
      )
      .mockResolvedValueOnce(
        createFetchResponse({ cloudaicompanionProject: 'managed-project' })
      )
      .mockResolvedValueOnce(
        createFetchResponse({
          response: createResponse({
            content: { role: 'model', parts: [{ text: 'First call' }] },
          }),
        })
      )
      .mockResolvedValueOnce(
        createFetchResponse({
          response: createResponse({
            content: { role: 'model', parts: [{ text: 'Second call' }] },
          }),
        })
      );

    const { hooks, tool } = await createEnv(WEBSEARCH_CONFIG);
    await invokeAuthLoader(hooks, 'google', {
      type: 'oauth',
      access: 'expired-access',
      refresh: 'refresh-token-cache|project-id|',
      expires: Date.now() - 1,
    });

    const context = createToolContext();

    const first = await tool.execute({ query: 'oauth query' }, context);
    const second = await tool.execute({ query: 'oauth query' }, context);

    expect(first).toContain('First call');
    expect(second).toContain('Second call');
    expect(fetchMock).toHaveBeenCalledTimes(4);
    const generateHeaders = (fetchMock.mock.calls[2]?.[1]?.headers ?? {}) as Record<
      string,
      string
    >;
    const secondHeaders = (fetchMock.mock.calls[3]?.[1]?.headers ?? {}) as Record<
      string,
      string
    >;
    expect(generateHeaders.Authorization).toBe('Bearer cached-access');
    expect(secondHeaders.Authorization).toBe('Bearer cached-access');
  });

  it('returns invalid auth when OpenAI websearch is configured but auth is missing', async () => {
    const { tool } = await createEnv({
      provider: {
        openai: {
          options: {
            websearch_cited: { model: 'gpt-4o-search-preview' },
          },
        },
      },
    } as Config);
    const context = createToolContext();

    await expectThrowMessage(
      () => tool.execute({ query: 'openai' }, context),
      'Missing auth for provider "openai"'
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns invalid auth when OpenRouter websearch is configured but auth is missing', async () => {
    const { tool } = await createEnv({
      provider: {
        openrouter: {
          options: {
            websearch_cited: { model: 'openrouter/auto' },
          },
        },
      },
    } as Config);
    const context = createToolContext();

    await expectThrowMessage(
      () => tool.execute({ query: 'openrouter' }, context),
      'Missing auth for provider "openrouter"'
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses the OpenAI responses endpoint when configured and auth is present', async () => {
    fetchMock.mockResolvedValueOnce(
      createFetchResponse(createOpenAIResponseBody('Search result body'))
    );

    const { hooks, tool } = await createEnv({
      provider: {
        openai: {
          options: {
            websearch_cited: { model: 'gpt-4o-search-preview' },
          },
        },
      },
    } as Config);

    await invokeAuthLoader(hooks, 'openai', {
      type: 'oauth',
      access: 'test-access-token',
      refresh: 'test-refresh-token',
      expires: Date.now() + 60_000,
    });

    const context = createToolContext();

    const result = await tool.execute({ query: 'openai web search' }, context);

    expect(result).toContain('Search result body');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(typeof url === 'string' ? url : '').toContain('/codex/responses');
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer test-access-token');
  });

  it('uses the OpenAI API endpoint when API key auth is present', async () => {
    fetchMock.mockResolvedValueOnce(
      createFetchResponse(createOpenAIResponseBody('Search result body'))
    );

    const { hooks, tool } = await createEnv({
      provider: {
        openai: {
          options: {
            websearch_cited: { model: 'gpt-4o-search-preview' },
          },
        },
      },
    } as Config);

    await invokeAuthLoader(hooks, 'openai', {
      type: 'api',
      key: 'test-api-key',
    });

    const context = createToolContext();

    const result = await tool.execute({ query: 'openai web search' }, context);

    expect(result).toContain('Search result body');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(typeof url === 'string' ? url : '').toContain(
      'https://api.openai.com/v1/responses'
    );
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer test-api-key');
  });

  it('uses the OpenRouter responses endpoint when configured and auth is present', async () => {
    fetchMock.mockResolvedValueOnce(
      createFetchResponse(createOpenRouterResponseBody('Search result body'))
    );

    const { hooks, tool } = await createEnv({
      provider: {
        openrouter: {
          options: {
            websearch_cited: { model: 'openrouter/auto' },
          },
        },
      },
    } as Config);

    await invokeAuthLoader(hooks, 'openrouter', {
      type: 'api',
      key: 'test-openrouter-key',
    });

    const context = createToolContext();

    const result = await tool.execute({ query: 'openrouter web search' }, context);

    expect(result).toContain('Search result body');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(typeof url === 'string' ? url : '').toContain(
      'https://openrouter.ai/api/v1/responses'
    );

    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer test-openrouter-key');

    const bodyText = typeof init?.body === 'string' ? init.body : '';
    const parsed = JSON.parse(bodyText) as Record<string, unknown>;
    expect(parsed.model).toBe('openrouter/auto');
    expect(parsed.store).toBe(false);
    expect(parsed.stream).toBe(false);

    const plugins = parsed.plugins;
    expect(Array.isArray(plugins)).toBe(true);
    const plugin0 =
      Array.isArray(plugins) && plugins[0] && typeof plugins[0] === 'object'
        ? (plugins[0] as Record<string, unknown>)
        : undefined;
    expect(plugin0?.id).toBe('web');

    const searchPromptValue = plugin0?.search_prompt;
    expect(typeof searchPromptValue === 'string' ? searchPromptValue : '').toContain(
      'perform web search on "openrouter web search"'
    );
  });

  it('selects the first configured provider in order', async () => {
    fetchMock.mockResolvedValueOnce(
      createFetchResponse(createOpenAIResponseBody('Search result body'))
    );

    const { hooks, tool } = await createEnv({
      provider: {
        openai: {
          options: {
            websearch_cited: { model: 'gpt-4o-search-preview' },
          },
        },
        google: {
          options: {
            websearch_cited: { model: 'gemini-2.5-flash' },
          },
        },
      },
    } as Config);

    await invokeAuthLoader(hooks, 'openai', {
      type: 'oauth',
      access: 'test-access-token',
      refresh: 'test-refresh-token',
      expires: Date.now() + 60_000,
    });

    const context = createToolContext();

    const result = await tool.execute({ query: 'openai web search' }, context);

    expect(result).toContain('Search result body');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0] ?? [];
    expect(typeof url === 'string' ? url : '').toContain('/codex/responses');
  });

  it('index exports are valid plugin init functions', async () => {
    const mod = await importIndexModule();
    const entries = Object.entries(mod);
    expect(entries.length).toBeGreaterThan(0);
    for (const [name, value] of entries) {
      expect(name.trim()).not.toBe('');
      expect(typeof value).toBe('function');
    }
  });

  it('initializes all exports like opencode', async () => {
    const mod = await importIndexModule();
    const input = createPluginInput();
    const hooks: unknown[] = [];
    for (const [name, value] of Object.entries(mod)) {
      if (typeof value !== 'function') {
        throw new Error(`Invalid plugin export "${name}"`);
      }
      hooks.push(await (value as Plugin)(input));
    }
    for (const hook of hooks) {
      expect(hook && typeof hook === 'object').toBe(true);
    }
  });
});

type CandidateInput = NonNullable<
  WebSearchGenerateContentResponse['candidates']
>[number];

async function expectThrowMessage(fn: () => Promise<unknown>, match: string) {
  try {
    await fn();
    throw new Error('Expected function to throw');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    expect(message).toContain(match);
  }
}

type Hooks = Awaited<ReturnType<Plugin>>;

type Tool = {
  execute: (args: unknown, context: unknown) => Promise<string>;
};

function isTool(value: unknown): value is Tool {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const execute = (value as Record<string, unknown>).execute;
  return typeof execute === 'function';
}

function createPluginInput(): PluginInput {
  return {} as PluginInput;
}

async function importIndexModule(): Promise<Record<string, unknown>> {
  importCounter += 1;
  const mod = (await import(`./index?agent_test=${importCounter}`)) as unknown;
  if (!mod || typeof mod !== 'object') {
    throw new Error('Invalid plugin module');
  }
  return mod as Record<string, unknown>;
}

async function createEnv(config?: Config): Promise<{ hooks: Hooks[]; tool: Tool }> {
  const mod = await importIndexModule();
  const input = createPluginInput();
  const hooks: Hooks[] = [];

  for (const [name, value] of Object.entries(mod)) {
    if (typeof value !== 'function') {
      throw new Error(`Invalid plugin export "${name}"`);
    }
    hooks.push(await (value as Plugin)(input));
  }

  if (config) {
    for (const hook of hooks) {
      const configHook = (hook as Record<string, unknown>).config;
      if (typeof configHook === 'function') {
        await (configHook as (c: Config) => Promise<unknown>)(config);
      }
    }
  }

  const tool = findTool(hooks, 'websearch_cited');
  if (!tool) {
    throw new Error('Tool "websearch_cited" not registered');
  }

  return { hooks, tool };
}

function findAuthHook(hooks: Hooks[], providerID: string): Hooks | undefined {
  for (const hook of hooks) {
    const auth = (hook as Record<string, unknown>).auth;
    if (!auth || typeof auth !== 'object') {
      continue;
    }
    if ((auth as Record<string, unknown>).provider === providerID) {
      return hook;
    }
  }
  return undefined;
}

async function invokeAuthLoader(
  hooks: Hooks[],
  providerID: string,
  auth: ProviderAuth
): Promise<void> {
  const hook = findAuthHook(hooks, providerID);
  const authRecord = (hook as Record<string, unknown> | undefined)?.auth;
  const loader = (authRecord as Record<string, unknown> | undefined)?.loader;
  if (typeof loader !== 'function') {
    return;
  }

  await (loader as (g: () => Promise<ProviderAuth>, p: Provider) => Promise<unknown>)(
    () => Promise.resolve(auth),
    {} as Provider
  );
}

function findTool(hooks: Hooks[], name: string): Tool | undefined {
  let found: unknown;
  for (const hook of hooks) {
    const tool = (hook as Record<string, unknown>).tool;
    if (!tool || typeof tool !== 'object') {
      continue;
    }

    const candidate = (tool as Record<string, unknown>)[name];
    if (!candidate) {
      continue;
    }

    if (found) {
      throw new Error(`Tool "${name}" registered multiple times`);
    }

    found = candidate;
  }

  if (!isTool(found)) {
    return undefined;
  }

  return found;
}

function createResponse(candidate: CandidateInput): WebSearchGenerateContentResponse {
  return {
    candidates: [candidate],
  };
}

function createFetchResponse(
  body: unknown,
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

function createOpenAIResponseBody(text: string): unknown {
  return {
    output: [
      {
        role: 'assistant',
        content: [
          {
            type: 'output_text',
            text: {
              value: text,
            },
          },
        ],
      },
    ],
  };
}

function createOpenRouterResponseBody(text: string): unknown {
  return {
    output_text: text,
  };
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
