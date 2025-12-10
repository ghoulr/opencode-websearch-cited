import { type Plugin, tool } from '@opencode-ai/plugin';
import type { Config } from '@opencode-ai/sdk';

import {
  buildErrorResult,
  extractApiKey,
  formatWebSearchResponse,
  resolveGeminiApiKey,
  runGeminiWebSearch,
} from '@/gemini';
import { WEBSEARCH_ERROR, WEBSEARCH_ERROR_MESSAGES } from '@/types';

const GEMINI_PROVIDER_ID = 'google';

const GEMINI_TOOL_DESCRIPTION =
  'Performs a web search using Google Search (via the Gemini API) and returns the results. This tool is useful for finding information on the internet based on a query.';

const WEBSEARCH_ARGS = {
  query: tool.schema.string().describe('The natural-language web search query.'),
} as const;

const WEBSEARCH_ALLOWED_KEYS = new Set(Object.keys(WEBSEARCH_ARGS));

const WEBSEARCH_ALLOWED_KEYS_DESCRIPTION = Array.from(WEBSEARCH_ALLOWED_KEYS)
  .map((key) => `'${key}'`)
  .join(', ');

export const WebsearchGeminiPlugin: Plugin = () => {
  let googleApiKeyFromAuth: string | undefined;
  let geminiWebsearchModel: string | undefined;

  function parseWebsearchModel(config: Config): string | undefined {
    const providerConfig = config.provider?.[GEMINI_PROVIDER_ID];
    const providerOptions = providerConfig?.options;
    if (
      providerOptions &&
      typeof providerOptions === 'object' &&
      'websearch' in providerOptions
    ) {
      const websearch = (providerOptions as { websearch?: unknown }).websearch;
      if (websearch && typeof websearch === 'object' && !Array.isArray(websearch)) {
        const candidate = (websearch as { model?: unknown }).model;
        if (typeof candidate === 'string') {
          const trimmed = candidate.trim();
          if (trimmed !== '') {
            return trimmed;
          }
        }
      }
    }
    return undefined;
  }

  return Promise.resolve({
    auth: {
      provider: GEMINI_PROVIDER_ID,
      async loader(getAuth) {
        try {
          const authDetails = await getAuth();
          googleApiKeyFromAuth = extractApiKey(authDetails);
        } catch {
          googleApiKeyFromAuth = undefined;
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
      geminiWebsearchModel = parseWebsearchModel(config);
      return Promise.resolve();
    },
    tool: {
      websearch: tool({
        description: GEMINI_TOOL_DESCRIPTION,
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

          if (!geminiWebsearchModel) {
            return JSON.stringify(
              buildErrorResult(
                WEBSEARCH_ERROR_MESSAGES.invalidModel,
                WEBSEARCH_ERROR.invalidModel,
                'Set provider.google.options.websearch.model to a supported Gemini model.'
              )
            );
          }

          const apiKey = resolveGeminiApiKey(googleApiKeyFromAuth);
          if (!apiKey) {
            return JSON.stringify(
              buildErrorResult(
                WEBSEARCH_ERROR_MESSAGES.invalidAuth,
                WEBSEARCH_ERROR.invalidAuth,
                'Authenticate the Google provider via `opencode auth login` with a Gemini API key.'
              )
            );
          }

          let response;
          try {
            response = await runGeminiWebSearch({
              apiKey,
              model: geminiWebsearchModel,
              query,
              abortSignal: context.abort,
            });
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

          const formatted = formatWebSearchResponse(response, query);
          return JSON.stringify(formatted);
        },
      }),
    },
  });
};

export { formatWebSearchResponse } from '@/gemini';
export type { WebSearchResult } from '@/types';

export default WebsearchGeminiPlugin;
