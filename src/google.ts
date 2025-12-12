import type { Auth as ProviderAuth } from '@opencode-ai/sdk';
import { type GetAuth, type WebsearchClient } from './types.ts';

type GeminiChunkWeb = {
  title?: string;
  uri?: string;
};

type GeminiChunk = {
  web?: GeminiChunkWeb;
};

type GeminiSupportSegment = {
  startIndex?: number;
  endIndex?: number;
};

type GeminiSupport = {
  segment?: GeminiSupportSegment;
  groundingChunkIndices?: number[];
};

type GeminiMetadata = {
  groundingChunks?: GeminiChunk[];
  groundingSupports?: GeminiSupport[];
};

type GeminiTextPart = {
  text?: string;
  thought?: unknown;
};

type GeminiContent = {
  role?: string;
  parts?: GeminiTextPart[];
};

type GeminiCandidate = {
  content?: GeminiContent;
  groundingMetadata?: GeminiMetadata;
};

type GeminiGenerateContentResponse = {
  candidates?: GeminiCandidate[];
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

type GeminiClientConfig =
  | {
      mode: 'api';
      apiKey: string;
      model: string;
    }
  | {
      mode: 'oauth';
      accessToken: string;
      model: string;
      projectId: string;
    };

interface WebSearchClient {
  search(query: string, abortSignal: AbortSignal): Promise<string>;
}

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const GEMINI_CODE_ASSIST_ENDPOINT = 'https://cloudcode-pa.googleapis.com';
const GEMINI_CODE_ASSIST_GENERATE_PATH = '/v1internal:generateContent';

const CODE_ASSIST_HEADERS = {
  'User-Agent': 'google-api-nodejs-client/9.15.1',
  'X-Goog-Api-Client': 'gl-node/22.17.0',
  'Client-Metadata':
    'ideType=IDE_UNSPECIFIED,platform=PLATFORM_UNSPECIFIED,pluginType=GEMINI',
} as const;

function buildGeminiUrl(model: string): string {
  const encoded = encodeURIComponent(model);
  return `${GEMINI_API_BASE}/models/${encoded}:generateContent`;
}

async function runGeminiWebSearch(
  options: GeminiWebSearchOptions
): Promise<GeminiGenerateContentResponse> {
  const response = await fetch(buildGeminiUrl(options.model), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': options.apiKey,
      'User-Agent': CODE_ASSIST_HEADERS['User-Agent'],
      'X-Goog-Api-Client': CODE_ASSIST_HEADERS['X-Goog-Api-Client'],
      'Client-Metadata': CODE_ASSIST_HEADERS['Client-Metadata'],
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
    const message = await readErrorMessage(response);
    throw new Error(message ?? `Request failed with status ${response.status}`);
  }

  return (await response.json()) as GeminiGenerateContentResponse;
}

export function formatWebSearchResponse(
  response: GeminiGenerateContentResponse,
  query: string
): string {
  const responseText = extractResponseText(response);

  if (!responseText || !responseText.trim()) {
    return `No search results or information found for query: "${query}"`;
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

  return modifiedText;
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

class GeminiApiKeyClient implements WebSearchClient {
  private readonly apiKey: string;
  private readonly model: string;

  constructor(apiKey: string, model: string) {
    const normalizedKey = apiKey.trim();
    const normalizedModel = model.trim();
    if (!normalizedKey || !normalizedModel) {
      throw new Error('Invalid Google API configuration');
    }
    this.apiKey = normalizedKey;
    this.model = normalizedModel;
  }

  async search(query: string, abortSignal: AbortSignal): Promise<string> {
    const normalizedQuery = query.trim();
    const response = await runGeminiWebSearch({
      apiKey: this.apiKey,
      model: this.model,
      query: normalizedQuery,
      abortSignal,
    });
    return formatWebSearchResponse(response, normalizedQuery);
  }
}

class GeminiOAuthClient implements WebSearchClient {
  private readonly accessToken: string;
  private readonly model: string;
  private readonly projectId: string;

  constructor(accessToken: string, model: string, projectId: string) {
    const normalizedToken = accessToken.trim();
    const normalizedModel = model.trim();
    const normalizedProject = projectId.trim();
    if (!normalizedToken || !normalizedModel || !normalizedProject) {
      throw new Error('Invalid Google OAuth configuration');
    }
    this.accessToken = normalizedToken;
    this.model = normalizedModel;
    this.projectId = normalizedProject;
  }

  async search(query: string, abortSignal: AbortSignal): Promise<string> {
    const normalizedQuery = query.trim();
    const url = `${GEMINI_CODE_ASSIST_ENDPOINT}${GEMINI_CODE_ASSIST_GENERATE_PATH}`;

    const requestPayload: Record<string, unknown> = {
      contents: [
        {
          role: 'user',
          parts: [{ text: normalizedQuery }],
        },
      ],
      tools: [{ googleSearch: {} }],
    };

    const body: Record<string, unknown> = {
      project: this.projectId,
      model: this.model,
      request: requestPayload,
    };

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.accessToken}`,
      'User-Agent': CODE_ASSIST_HEADERS['User-Agent'],
      'X-Goog-Api-Client': CODE_ASSIST_HEADERS['X-Goog-Api-Client'],
      'Client-Metadata': CODE_ASSIST_HEADERS['Client-Metadata'],
    };

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: abortSignal,
    });

    if (!response.ok) {
      const message = await readErrorMessage(response);
      throw new Error(message ?? `Request failed with status ${response.status}`);
    }

    const text = await response.text();
    if (!text) {
      throw new Error('Empty response from Google Code Assist');
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      throw new Error('Invalid JSON response from Google Code Assist');
    }

    const effectiveResponse = extractGenerateContentResponse(parsed);
    if (!effectiveResponse) {
      throw new Error(
        'Google Code Assist response did not include a valid response payload'
      );
    }

    return formatWebSearchResponse(effectiveResponse, normalizedQuery);
  }
}

function extractGenerateContentResponse(
  payload: unknown
): GeminiGenerateContentResponse | undefined {
  const candidateObject = (() => {
    if (Array.isArray(payload)) {
      for (const item of payload) {
        if (item && typeof item === 'object') {
          return item as Record<string, unknown>;
        }
      }
      return undefined;
    }
    if (payload && typeof payload === 'object') {
      return payload as Record<string, unknown>;
    }
    return undefined;
  })();

  if (!candidateObject) {
    return undefined;
  }

  const withResponse = candidateObject as {
    response?: unknown;
    candidates?: unknown;
  };

  if (withResponse.response && typeof withResponse.response === 'object') {
    return withResponse.response as GeminiGenerateContentResponse;
  }

  if (withResponse.candidates) {
    return candidateObject as unknown as GeminiGenerateContentResponse;
  }

  return undefined;
}

async function readErrorMessage(response: Response): Promise<string | undefined> {
  try {
    const errorBody = (await response.json()) as {
      error?: { message?: string };
    };
    if (errorBody.error?.message && typeof errorBody.error.message === 'string') {
      return errorBody.error.message;
    }
  } catch {}

  try {
    const fallbackText = await response.text();
    return fallbackText || undefined;
  } catch {
    return undefined;
  }
}

function createGeminiWebSearchClient(config: GeminiClientConfig): WebSearchClient {
  if (config.mode === 'api') {
    return new GeminiApiKeyClient(config.apiKey, config.model);
  }

  return new GeminiOAuthClient(config.accessToken, config.model, config.projectId);
}

function createWebSearchClientForGoogle(
  authDetails: ProviderAuth,
  model: string
): WebSearchClient {
  if (authDetails.type === 'api') {
    const apiKey = extractApiKey(authDetails);
    if (!apiKey) {
      throw new Error('Missing Google API key');
    }
    return createGeminiWebSearchClient({
      mode: 'api',
      apiKey,
      model,
    });
  }

  if (authDetails.type === 'oauth') {
    const oauthAuth = authDetails as {
      type: 'oauth';
      access?: string;
      refresh?: string;
    };
    const accessToken = oauthAuth.access?.trim() ?? '';
    if (!accessToken) {
      throw new Error('Missing Google OAuth access token');
    }

    const refreshValue = oauthAuth.refresh?.trim() ?? '';
    const parts = refreshValue.split('|');
    const projectIdRaw = parts.length >= 2 ? (parts[1] ?? '') : '';
    const managedProjectIdRaw = parts.length >= 3 ? (parts[2] ?? '') : '';

    const projectId = projectIdRaw.trim() !== '' ? projectIdRaw.trim() : undefined;
    const managedProjectId =
      managedProjectIdRaw.trim() !== '' ? managedProjectIdRaw.trim() : undefined;

    const effectiveProjectId = projectId ?? managedProjectId;
    if (!effectiveProjectId) {
      throw new Error(
        'Google Gemini requires a Google Cloud project. Enable the Gemini for Google Cloud API on a project you control, rerun `opencode auth login`, and supply that project ID when prompted.'
      );
    }

    return createGeminiWebSearchClient({
      mode: 'oauth',
      accessToken,
      model,
      projectId: effectiveProjectId,
    });
  }

  throw new Error('Unsupported auth type for Google web search');
}

function extractApiKey(authDetails?: ProviderAuth | null): string | undefined {
  if (!authDetails || authDetails.type !== 'api') {
    return undefined;
  }
  const normalized = authDetails.key.trim();
  return normalized === '' ? undefined : normalized;
}

export function createGoogleWebsearchClient(model: string): WebsearchClient {
  const normalizedModel = model.trim();
  if (!normalizedModel) {
    throw new Error('Invalid Google web search model');
  }

  return {
    async search(query, abortSignal, getAuth: GetAuth) {
      const normalizedQuery = query.trim();
      if (!normalizedQuery) {
        throw new Error('Query must not be empty');
      }

      const auth = await getAuth();
      if (!auth) {
        throw new Error('Missing auth for provider "google"');
      }

      const client = createWebSearchClientForGoogle(auth, normalizedModel);
      return client.search(normalizedQuery, abortSignal);
    },
  };
}
