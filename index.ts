import { type Plugin, tool } from '@opencode-ai/plugin';
import type { Auth as ProviderAuth, Config } from '@opencode-ai/sdk';

import { buildErrorResult, createWebSearchClientForGoogle } from '@/gemini';
import { runOpenAIWebSearch } from '@/openai';
import { WEBSEARCH_ERROR, WEBSEARCH_ERROR_MESSAGES } from '@/types';

const GEMINI_PROVIDER_ID = 'google';

type OpenAIWebsearchConfig = {
  reasoningEffort?: string;
  reasoningSummary?: string;
  textVerbosity?: string;
  store?: boolean;
  include?: string[];
};

let openaiAuth: ProviderAuth | undefined;
let openaiConfig: OpenAIWebsearchConfig = {};

const GROUNDED_SEARCH_TOOL_DESCRIPTION =
  'Performs a web search with LLM-grounded results and citations. This tool is useful for finding information on the internet with reliable sources and inline references.';

const WEBSEARCH_ARGS = {
  query: tool.schema.string().describe('The natural-language web search query.'),
} as const;

const WEBSEARCH_ALLOWED_KEYS = new Set(Object.keys(WEBSEARCH_ARGS));

const WEBSEARCH_ALLOWED_KEYS_DESCRIPTION = Array.from(WEBSEARCH_ALLOWED_KEYS)
  .map((key) => `'${key}'`)
  .join(', ');

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function parseOpenAIOptions(
  providerConfig: unknown,
  model: string | undefined
): OpenAIWebsearchConfig {
  if (!isRecord(providerConfig)) {
    return {};
  }

  const providerRecord = providerConfig;

  const rawOptions = (providerRecord as { options?: unknown }).options;
  const baseOptions = isRecord(rawOptions) ? rawOptions : undefined;

  let modelOptions: Record<string, unknown> | undefined;
  const rawModels = (providerRecord as { models?: unknown }).models;
  if (model && isRecord(rawModels)) {
    const modelsRecord: Record<string, unknown> = rawModels;
    const entry = modelsRecord[model];
    if (isRecord(entry)) {
      const entryOptions = (entry as { options?: unknown }).options;
      if (isRecord(entryOptions)) {
        modelOptions = entryOptions;
      }
    }
  }

  const merged: Record<string, unknown> = {
    ...(baseOptions ?? {}),
    ...(modelOptions ?? {}),
  };

  const result: OpenAIWebsearchConfig = {};

  const reasoningEffort = merged.reasoningEffort;
  if (typeof reasoningEffort === 'string' && reasoningEffort.trim() !== '') {
    result.reasoningEffort = reasoningEffort.trim();
  }

  const reasoningSummary = merged.reasoningSummary;
  if (typeof reasoningSummary === 'string' && reasoningSummary.trim() !== '') {
    result.reasoningSummary = reasoningSummary.trim();
  }

  const textVerbosity = merged.textVerbosity;
  if (typeof textVerbosity === 'string' && textVerbosity.trim() !== '') {
    result.textVerbosity = textVerbosity.trim();
  }

  const store = merged.store;
  if (typeof store === 'boolean') {
    result.store = store;
  }

  const include = merged.include;
  if (Array.isArray(include)) {
    const filtered = include.filter(
      (value) => typeof value === 'string' && value.trim() !== ''
    );
    if (filtered.length > 0) {
      result.include = filtered;
    }
  }

  return result;
}

export const WebsearchGeminiPlugin: Plugin = () => {
  let providerAuth: ProviderAuth | undefined;
  let geminiWebsearchModel: string | undefined;
  let openaiWebsearchModel: string | undefined;
  let websearchClient: ReturnType<typeof createWebSearchClientForGoogle> | undefined;

  function parseGeminiWebsearchModel(config: Config): string | undefined {
    const providerConfig = config.provider?.[GEMINI_PROVIDER_ID];
    const providerOptions = providerConfig?.options;
    if (
      !providerOptions ||
      typeof providerOptions !== 'object' ||
      Array.isArray(providerOptions)
    ) {
      return undefined;
    }

    const groundedBlock = (providerOptions as Record<string, unknown>)[
      'websearch_grounded'
    ];
    if (
      !groundedBlock ||
      typeof groundedBlock !== 'object' ||
      Array.isArray(groundedBlock)
    ) {
      return undefined;
    }

    const candidate = (groundedBlock as { model?: unknown }).model;
    if (typeof candidate !== 'string') {
      return undefined;
    }
    const trimmed = candidate.trim();
    return trimmed === '' ? undefined : trimmed;
  }

  function parseOpenAIWebsearchModel(config: Config): string | undefined {
    const providerConfig = config.provider?.openai;
    const providerOptions = providerConfig?.options;
    if (
      !providerOptions ||
      typeof providerOptions !== 'object' ||
      Array.isArray(providerOptions)
    ) {
      return undefined;
    }

    const groundedBlock = (providerOptions as Record<string, unknown>)[
      'websearch_grounded'
    ];
    if (
      !groundedBlock ||
      typeof groundedBlock !== 'object' ||
      Array.isArray(groundedBlock)
    ) {
      return undefined;
    }

    const candidate = (groundedBlock as { model?: unknown }).model;
    if (typeof candidate !== 'string') {
      return undefined;
    }
    const trimmed = candidate.trim();
    return trimmed === '' ? undefined : trimmed;
  }

  return Promise.resolve({
    auth: {
      provider: GEMINI_PROVIDER_ID,
      async loader(getAuth) {
        try {
          const authDetails = await getAuth();
          providerAuth = authDetails;
          websearchClient = undefined;
        } catch {
          providerAuth = undefined;
          websearchClient = undefined;
        }
        return {};
      },
      methods: [
        {
          type: 'api',
          label: 'Google API key',
        },
      ],
    },
    config: (config) => {
      geminiWebsearchModel = parseGeminiWebsearchModel(config);
      openaiWebsearchModel = parseOpenAIWebsearchModel(config);
      const openaiProvider = config.provider?.openai;
      openaiConfig = parseOpenAIOptions(openaiProvider, openaiWebsearchModel);
      websearchClient = undefined;
      return Promise.resolve();
    },
    tool: {
      websearch_grounded: tool({
        description: GROUNDED_SEARCH_TOOL_DESCRIPTION,
        args: WEBSEARCH_ARGS,
        async execute(args, context) {
          const argKeys = Object.keys(args ?? {});
          const extraKeys = argKeys.filter((key) => !WEBSEARCH_ALLOWED_KEYS.has(key));
          if (extraKeys.length > 0) {
            return JSON.stringify(
              buildErrorResult(
                WEBSEARCH_ERROR_MESSAGES.invalidToolArguments,
                WEBSEARCH_ERROR.invalidToolArguments,
                `Unknown argument(s): ${extraKeys.join(
                  ', '
                )}, only ${WEBSEARCH_ALLOWED_KEYS_DESCRIPTION} supported.`
              )
            );
          }

          const query = args.query?.trim();
          if (!query) {
            return JSON.stringify(
              buildErrorResult(
                WEBSEARCH_ERROR_MESSAGES.invalidQuery,
                WEBSEARCH_ERROR.invalidQuery
              )
            );
          }

          const openaiModel = openaiWebsearchModel;
          if (openaiModel) {
            const auth = openaiAuth;
            if (!auth) {
              return JSON.stringify(
                buildErrorResult(
                  WEBSEARCH_ERROR_MESSAGES.invalidAuth,
                  WEBSEARCH_ERROR.invalidAuth,
                  'Authenticate the OpenAI provider via `opencode auth login` using the OpenAI Codex OAuth plugin.'
                )
              );
            }

            try {
              const result = await runOpenAIWebSearch({
                model: openaiModel,
                query,
                abortSignal: context.abort,
                auth,
                reasoningEffort: openaiConfig.reasoningEffort,
                reasoningSummary: openaiConfig.reasoningSummary,
                textVerbosity: openaiConfig.textVerbosity,
                store: openaiConfig.store,
                include: openaiConfig.include,
              });
              return JSON.stringify(result);
            } catch (error) {
              console.warn('OpenAI web search failed.', error);
              const message = error instanceof Error ? error.message : String(error);
              return JSON.stringify(
                buildErrorResult(
                  WEBSEARCH_ERROR_MESSAGES.webSearchFailed,
                  WEBSEARCH_ERROR.webSearchFailed,
                  `OpenAI web search request failed: ${message}`
                )
              );
            }
          }

          const model = geminiWebsearchModel;
          if (!model) {
            return JSON.stringify(
              buildErrorResult(
                WEBSEARCH_ERROR_MESSAGES.invalidModel,
                WEBSEARCH_ERROR.invalidModel
              )
            );
          }

          const authDetails = providerAuth;
          if (!authDetails) {
            return JSON.stringify(
              buildErrorResult(
                WEBSEARCH_ERROR_MESSAGES.invalidAuth,
                WEBSEARCH_ERROR.invalidAuth,
                'Authenticate the Google provider via `opencode auth login` using OAuth or an API key.'
              )
            );
          }

          if (!websearchClient) {
            try {
              websearchClient = createWebSearchClientForGoogle(authDetails, model);
            } catch {
              return JSON.stringify(
                buildErrorResult(
                  WEBSEARCH_ERROR_MESSAGES.invalidAuth,
                  WEBSEARCH_ERROR.invalidAuth,
                  'Authenticate the Google provider via `opencode auth login` using OAuth or an API key.'
                )
              );
            }
          }

          try {
            const result = await websearchClient.search(query, context.abort);
            return JSON.stringify(result);
          } catch (error) {
            console.warn('Gemini web search failed.', error);
            const message = error instanceof Error ? error.message : String(error);
            return JSON.stringify(
              buildErrorResult(
                WEBSEARCH_ERROR_MESSAGES.webSearchFailed,
                WEBSEARCH_ERROR.webSearchFailed,
                `Gemini web search request failed: ${message}`
              )
            );
          }
        },
      }),
    },
  });
};

export const WebsearchOpenAIAuthPlugin: Plugin = () => {
  return Promise.resolve({
    auth: {
      provider: 'openai',
      async loader(getAuth) {
        try {
          const authDetails = await getAuth();
          openaiAuth = authDetails;
        } catch {
          openaiAuth = undefined;
        }
        return {};
      },
      methods: [],
    },
  });
};

export { formatWebSearchResponse } from '@/gemini';
export type { WebSearchResult } from '@/types';

export default WebsearchGeminiPlugin;
