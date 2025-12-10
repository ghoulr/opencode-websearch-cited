import type { Auth as ProviderAuth } from '@opencode-ai/sdk';
import {
  type GeminiGenerateContentResponse,
  type GeminiMetadata,
  type WebSearchErrorType,
  type WebSearchResult,
} from './types.ts';

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

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

function buildGeminiUrl(model: string): string {
  const encoded = encodeURIComponent(model);
  return `${GEMINI_API_BASE}/models/${encoded}:generateContent`;
}

export async function runGeminiWebSearch(
  options: GeminiWebSearchOptions
): Promise<GeminiGenerateContentResponse> {
  const response = await fetch(buildGeminiUrl(options.model), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': options.apiKey,
    },
    body: JSON.stringify({
      contents: [
        {
          role: 'user',
          parts: [{ text: options.query }],
        },
      ],
      tools: [{ googleSearch: {} }],
    }),
    signal: options.abortSignal,
  });

  if (!response.ok) {
    let message: string | undefined;
    try {
      const errorBody = (await response.json()) as {
        error?: { message?: string };
      };
      message = errorBody.error?.message;
    } catch {
      // ignore
    }

    if (!message) {
      try {
        const fallbackText = await response.text();
        message = fallbackText || undefined;
      } catch {
        // ignore
      }
    }

    throw new Error(message ?? `Request failed with status ${response.status}`);
  }

  return (await response.json()) as GeminiGenerateContentResponse;
}

export function formatWebSearchResponse(
  response: GeminiGenerateContentResponse,
  query: string
): WebSearchResult {
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

  const result: WebSearchResult = {
    llmContent,
    returnDisplay: `Search results for "${query}" returned.`,
  };

  if (hasSources && sources) {
    result.sources = sources;
  }

  return result;
}

function extractResponseText(
  response: GeminiGenerateContentResponse
): string | undefined {
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
  response: GeminiGenerateContentResponse
): GeminiMetadata | undefined {
  return response.candidates?.[0]?.groundingMetadata;
}

function buildCitationInsertions(metadata?: GeminiMetadata): CitationInsertion[] {
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

export function resolveGeminiApiKey(storedKey?: string): string | undefined {
  const normalizedStored = storedKey?.trim();
  return normalizedStored && normalizedStored !== '' ? normalizedStored : undefined;
}

export function extractApiKey(authDetails?: ProviderAuth | null): string | undefined {
  if (!authDetails || authDetails.type !== 'api') {
    return undefined;
  }
  const normalized = authDetails.key.trim();
  return normalized === '' ? undefined : normalized;
}

export function buildErrorResult(
  message: string,
  code: WebSearchErrorType,
  details?: string
): WebSearchResult {
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
