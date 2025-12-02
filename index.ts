import { type Plugin, tool } from '@opencode-ai/plugin';
import type { Auth as ProviderAuth } from '@opencode-ai/sdk';
import { GoogleGenAI, type GenerateContentResponse } from '@google/genai';

const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash';
const GEMINI_PROVIDER_ID = 'google';
const GEMINI_TOOL_DESCRIPTION =
  'Performs a web search using Google Search (via the Gemini API) and returns the results. This tool is useful for finding information on the internet based on a query.';

export type GeminiSearchResult = {
  llmContent: string;
  returnDisplay: string;
  sources?: GroundingChunkItem[];
  error?: {
    message: string;
    type?: string;
  };
};

type GroundingChunkWeb = {
  title?: string;
  uri?: string;
};

type GroundingChunkItem = {
  web?: GroundingChunkWeb;
};

type GroundingSupportSegment = {
  startIndex?: number;
  endIndex?: number;
};

type GroundingSupportItem = {
  segment?: GroundingSupportSegment;
  groundingChunkIndices?: number[];
};

type GroundingMetadataLike = {
  groundingChunks?: GroundingChunkItem[];
  groundingSupports?: GroundingSupportItem[];
};

type CitationInsertion = {
  index: number;
  marker: string;
};

type GeminiWebSearchOptions = {
  apiKey: string;
  model: string;
  query: string;
  abortSignal: AbortSignal;
};

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
        args: {
          query: tool.schema
            .string()
            .describe('The natural-language web search query.'),
        },
        async execute(args, context) {
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

          let response: GenerateContentResponse;
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

export default WebsearchGeminiPlugin;

async function runGeminiWebSearch(
  options: GeminiWebSearchOptions
): Promise<GenerateContentResponse> {
  const client = new GoogleGenAI({ apiKey: options.apiKey });
  return client.models.generateContent({
    model: options.model,
    contents: [
      {
        role: 'user',
        parts: [{ text: options.query }],
      },
    ],
    config: {
      tools: [{ googleSearch: {} }],
      abortSignal: options.abortSignal,
    },
  });
}

export function formatWebSearchResponse(
  response: GenerateContentResponse,
  query: string
): GeminiSearchResult {
  const responseText = extractResponseText(response);

  if (!responseText || !responseText.trim()) {
    const message = `No search results or information found for query: "${query}"`;
    return {
      llmContent: message,
      returnDisplay: 'No information found.',
    };
  }

  const metadata = extractGroundingMetadata(response);
  const sources = metadata?.groundingChunks;
  const hasSources = Boolean(sources && sources.length > 0);

  let modifiedText = responseText;

  if (hasSources && metadata) {
    const insertions = buildCitationInsertions(metadata);
    if (insertions.length > 0) {
      modifiedText = insertMarkersByUtf8Index(modifiedText, insertions);
    }
  }

  if (hasSources && sources) {
    const sourceLines = sources.map((source, index) => {
      const title = source.web?.title || 'Untitled';
      const uri = source.web?.uri || 'No URI';
      return `[${index + 1}] ${title} (${uri})`;
    });
    modifiedText += `\n\nSources:\n${sourceLines.join('\n')}`;
  }

  const llmContent = `Web search results for "${query}":\n\n${modifiedText}`;

  const result: GeminiSearchResult = {
    llmContent,
    returnDisplay: `Search results for "${query}" returned.`,
  };

  if (hasSources && sources) {
    result.sources = sources;
  }

  return result;
}

function extractResponseText(response: GenerateContentResponse): string | undefined {
  const parts = response.candidates?.[0]?.content?.parts;
  if (!parts || parts.length === 0) {
    return undefined;
  }

  let combined = '';
  for (const part of parts) {
    if (part.thought) {
      continue;
    }
    if (typeof part.text === 'string') {
      combined += part.text;
    }
  }

  return combined || undefined;
}

function extractGroundingMetadata(
  response: GenerateContentResponse
): GroundingMetadataLike | undefined {
  const metadata = response.candidates?.[0]?.groundingMetadata as
    | GroundingMetadataLike
    | undefined;
  return metadata;
}

function buildCitationInsertions(
  metadata?: GroundingMetadataLike
): CitationInsertion[] {
  const supports = metadata?.groundingSupports;
  if (!supports || supports.length === 0) {
    return [];
  }

  const insertions: CitationInsertion[] = [];

  for (const support of supports) {
    const segment = support.segment;
    const indices = support.groundingChunkIndices;
    if (!segment || segment.endIndex == null || !indices || indices.length === 0) {
      continue;
    }

    const uniqueSorted = Array.from(new Set(indices)).sort((a, b) => a - b);
    const marker = uniqueSorted.map((idx) => `[${idx + 1}]`).join('');

    insertions.push({
      index: segment.endIndex,
      marker,
    });
  }

  insertions.sort((a, b) => b.index - a.index);
  return insertions;
}

function insertMarkersByUtf8Index(
  text: string,
  insertions: CitationInsertion[]
): string {
  if (insertions.length === 0) {
    return text;
  }

  const encoder = new TextEncoder();
  const responseBytes = encoder.encode(text);
  const parts: Uint8Array[] = [];
  let lastIndex = responseBytes.length;

  for (const insertion of insertions) {
    const position = Math.min(insertion.index, lastIndex);
    parts.unshift(responseBytes.subarray(position, lastIndex));
    parts.unshift(encoder.encode(insertion.marker));
    lastIndex = position;
  }

  parts.unshift(responseBytes.subarray(0, lastIndex));

  const totalLength = parts.reduce((sum, part) => sum + part.length, 0);
  const finalBytes = new Uint8Array(totalLength);
  let offset = 0;
  for (const part of parts) {
    finalBytes.set(part, offset);
    offset += part.length;
  }

  return new TextDecoder().decode(finalBytes);
}

function resolveGeminiApiKey(storedKey?: string): string | undefined {
  const normalizedStored = storedKey?.trim();
  if (normalizedStored) {
    return normalizedStored;
  }
  const envKey = process.env.GEMINI_API_KEY?.trim();
  return envKey && envKey !== '' ? envKey : undefined;
}

function extractApiKey(authDetails?: ProviderAuth | null): string | undefined {
  if (!authDetails || authDetails.type !== 'api') {
    return undefined;
  }
  const normalized = authDetails.key.trim();
  return normalized === '' ? undefined : normalized;
}

function buildErrorResult(
  message: string,
  code: string,
  details?: string
): GeminiSearchResult {
  const llmContent = details
    ? `Error: ${message}\n\nDetails: ${details}`
    : `Error: ${message}`;
  return {
    llmContent,
    returnDisplay: message,
    error: {
      message: details ?? message,
      type: code,
    },
  };
}
