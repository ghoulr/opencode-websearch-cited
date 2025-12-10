import { type Plugin, tool } from '@opencode-ai/plugin';

import {
  buildErrorResult,
  extractApiKey,
  formatWebSearchResponse,
  resolveGeminiApiKey,
  runGeminiWebSearch,
} from '@/gemini';

const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash';

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
    tool: {
      websearch_gemini: tool({
        description: GEMINI_TOOL_DESCRIPTION,
        args: WEBSEARCH_ARGS,
        async execute(args, context) {
          const argKeys = Object.keys(args ?? {});
          const extraKeys = argKeys.filter((key) => !WEBSEARCH_ALLOWED_KEYS.has(key));
          if (extraKeys.length > 0) {
            return JSON.stringify(
              buildErrorResult(
                "websearch_gemini only accepts a single 'query' field.",
                'INVALID_TOOL_ARGUMENTS',
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
                "The 'query' parameter cannot be empty.",
                'INVALID_QUERY'
              )
            );
          }

          const apiKey = resolveGeminiApiKey(googleApiKeyFromAuth);
          if (!apiKey) {
            return JSON.stringify(
              buildErrorResult(
                'Gemini web search is not configured. Please log in to the Google provider via `opencode auth login` or set GEMINI_API_KEY.',
                'MISSING_GEMINI_API_KEY'
              )
            );
          }

          let response;
          try {
            response = await runGeminiWebSearch({
              apiKey,
              model: DEFAULT_GEMINI_MODEL,
              query,
              abortSignal: context.abort,
            });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return JSON.stringify(
              buildErrorResult(
                'Gemini web search is currently unavailable. Please check your Gemini configuration and try again.',
                'GEMINI_WEB_SEARCH_FAILED',
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
