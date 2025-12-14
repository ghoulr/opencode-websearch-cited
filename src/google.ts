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

type GeminiClientConfig = {
  mode: 'api';
  apiKey: string;
  model: string;
};

type OAuthAuthDetails = {
  type: 'oauth';
  access?: string;
  refresh?: string;
  expires?: unknown;
};

type RefreshParts = {
  refreshToken: string;
  projectId?: string;
  managedProjectId?: string;
};

type TokenFlavor = 'gemini-cli' | 'antigravity';

type RefreshedToken = {
  accessToken: string;
  expiresAt: number;
  flavor: TokenFlavor;
};

interface WebSearchClient {
  search(query: string, abortSignal: AbortSignal): Promise<string>;
}

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const GEMINI_CODE_ASSIST_ENDPOINT = 'https://cloudcode-pa.googleapis.com';
const GEMINI_CODE_ASSIST_GENERATE_PATH = '/v1internal:generateContent';
const GEMINI_CODE_ASSIST_LOAD_PATH = '/v1internal:loadCodeAssist';
const OAUTH_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

const GEMINI_CLIENT_ID =
  '681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com';
const GEMINI_CLIENT_SECRET = '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';
const ANTIGRAVITY_CLIENT_ID =
  '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com';
const ANTIGRAVITY_CLIENT_SECRET = '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';

const REFRESH_BUFFER_MS = 60_000;

const CODE_ASSIST_HEADERS = {
  'User-Agent': 'google-api-nodejs-client/9.15.1',
  'X-Goog-Api-Client': 'gl-node/22.17.0',
  'Client-Metadata':
    'ideType=IDE_UNSPECIFIED,platform=PLATFORM_UNSPECIFIED,pluginType=GEMINI',
} as const;

const tokenCache = new Map<string, { accessToken: string; expiresAt: number }>();
const flavorCache = new Map<string, TokenFlavor>();
const projectCache = new Map<string, string>();

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

function parseRefresh(refresh: string): RefreshParts {
  const normalized = refresh.trim();
  if (!normalized) {
    return { refreshToken: '' };
  }
  const [token, project, managed] = normalized.split('|');
  const refreshToken = token?.trim() ?? '';
  const projectId = project?.trim() ?? '';
  const managedProjectId = managed?.trim() ?? '';
  return {
    refreshToken,
    projectId: projectId || undefined,
    managedProjectId: managedProjectId || undefined,
  };
}

function getFlavorOrder(preferred?: TokenFlavor): TokenFlavor[] {
  const base: TokenFlavor[] = ['antigravity', 'gemini-cli'];
  if (!preferred) {
    return base;
  }
  return [preferred, ...base.filter((flavor) => flavor !== preferred)];
}

function getCachedAccess(
  refreshToken: string
): { accessToken: string; expiresAt: number } | undefined {
  const cached = tokenCache.get(refreshToken);
  if (!cached) {
    return undefined;
  }
  if (cached.expiresAt <= Date.now() + REFRESH_BUFFER_MS) {
    tokenCache.delete(refreshToken);
    return undefined;
  }
  return cached;
}

function cacheToken(
  refreshToken: string,
  accessToken: string,
  expiresAt?: number
): void {
  if (!refreshToken || !accessToken) {
    return;
  }
  if (typeof expiresAt === 'number' && Number.isFinite(expiresAt)) {
    tokenCache.set(refreshToken, { accessToken, expiresAt });
  }
}

async function requestToken(
  refreshToken: string,
  flavor: TokenFlavor
): Promise<RefreshedToken> {
  const clientId = flavor === 'gemini-cli' ? GEMINI_CLIENT_ID : ANTIGRAVITY_CLIENT_ID;
  const clientSecret =
    flavor === 'gemini-cli' ? GEMINI_CLIENT_SECRET : ANTIGRAVITY_CLIENT_SECRET;

  const response = await fetch(OAUTH_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });

  if (!response.ok) {
    const message = await readErrorMessage(response);
    throw new Error(message ?? `Request failed with status ${response.status}`);
  }

  const payload = (await response.json()) as {
    access_token?: string;
    expires_in?: number;
  };
  if (!payload.access_token) {
    throw new Error('Token refresh response missing access_token');
  }
  const expiresIn = payload.expires_in;
  const expiresMs =
    typeof expiresIn === 'number' && Number.isFinite(expiresIn) ? expiresIn * 1000 : 0;

  return {
    accessToken: payload.access_token,
    expiresAt: Date.now() + expiresMs,
    flavor,
  };
}

async function refreshAccessToken(
  refreshToken: string,
  preferredFlavor?: TokenFlavor
): Promise<RefreshedToken> {
  const order = getFlavorOrder(preferredFlavor);
  const errors: string[] = [];

  for (const flavor of order) {
    try {
      const result = await requestToken(refreshToken, flavor);
      flavorCache.set(refreshToken, flavor);
      cacheToken(refreshToken, result.accessToken, result.expiresAt);
      return result;
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  const message =
    errors.length > 0 ? errors.join('; ') : 'Failed to refresh access token';
  throw new Error(message);
}

async function requestLoadCodeAssistProjectId(
  accessToken: string,
  abortSignal: AbortSignal
): Promise<
  { ok: true; projectId?: string } | { ok: false; status: number; message?: string }
> {
  const url = `${GEMINI_CODE_ASSIST_ENDPOINT}${GEMINI_CODE_ASSIST_LOAD_PATH}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
      'User-Agent': CODE_ASSIST_HEADERS['User-Agent'],
      'X-Goog-Api-Client': CODE_ASSIST_HEADERS['X-Goog-Api-Client'],
      'Client-Metadata': CODE_ASSIST_HEADERS['Client-Metadata'],
    },
    body: JSON.stringify({
      metadata: {
        ideType: 'IDE_UNSPECIFIED',
        platform: 'PLATFORM_UNSPECIFIED',
        pluginType: 'GEMINI',
      },
    }),
    signal: abortSignal,
  });

  if (!response.ok) {
    const message = await readErrorMessage(response);
    return { ok: false, status: response.status, message };
  }

  const payload = (await response.json()) as {
    cloudaicompanionProject?: string | { id?: unknown };
  };

  const project = payload.cloudaicompanionProject;
  if (typeof project === 'string' && project.trim() !== '') {
    return { ok: true, projectId: project };
  }

  if (project && typeof project === 'object') {
    const id = (project as Record<string, unknown>).id;
    if (typeof id === 'string' && id.trim() !== '') {
      return { ok: true, projectId: id };
    }
  }

  return { ok: true };
}

function parseExpires(expires: unknown): number | undefined {
  if (typeof expires === 'number' && Number.isFinite(expires)) {
    return expires;
  }
  return undefined;
}

async function requestGenerateContent(
  accessToken: string,
  projectId: string,
  model: string,
  query: string,
  abortSignal: AbortSignal
): Promise<
  | { ok: true; body: GeminiGenerateContentResponse }
  | { ok: false; status: number; message?: string }
> {
  const url = `${GEMINI_CODE_ASSIST_ENDPOINT}${GEMINI_CODE_ASSIST_GENERATE_PATH}`;

  const requestPayload: Record<string, unknown> = {
    contents: [
      {
        role: 'user',
        parts: [{ text: query }],
      },
    ],
    tools: [{ googleSearch: {} }],
  };

  const body: Record<string, unknown> = {
    project: projectId,
    model,
    request: requestPayload,
  };

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${accessToken}`,
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
    return { ok: false, status: response.status, message };
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

  return { ok: true, body: effectiveResponse };
}

function createGeminiOAuthWebSearchClient(
  authDetails: OAuthAuthDetails,
  model: string
): WebSearchClient {
  const refreshParts = parseRefresh(authDetails.refresh ?? '');
  const refreshToken = refreshParts.refreshToken;
  if (!refreshToken) {
    throw new Error('Missing Google OAuth refresh token');
  }

  const initialAccess = authDetails.access?.trim() ?? '';
  const initialExpires = parseExpires(authDetails.expires);

  return {
    async search(query: string, abortSignal: AbortSignal): Promise<string> {
      const normalizedQuery = query.trim();
      const preferredFlavor = flavorCache.get(refreshToken);

      const cached = getCachedAccess(refreshToken);
      let accessToken = cached?.accessToken ?? initialAccess;
      let expiresAt = cached?.expiresAt ?? initialExpires;

      const shouldRefreshNow =
        !accessToken ||
        (typeof expiresAt === 'number' && expiresAt <= Date.now() + REFRESH_BUFFER_MS);

      let refreshedThisRequest = false;

      if (shouldRefreshNow) {
        const refreshed = await refreshAccessToken(refreshToken, preferredFlavor);
        accessToken = refreshed.accessToken;
        expiresAt = refreshed.expiresAt;
        refreshedThisRequest = true;
      }

      if (!accessToken) {
        throw new Error('Missing Google OAuth access token');
      }

      if (typeof expiresAt === 'number') {
        cacheToken(refreshToken, accessToken, expiresAt);
      }

      let effectiveProjectId =
        refreshParts.projectId ??
        refreshParts.managedProjectId ??
        projectCache.get(refreshToken);

      if (!effectiveProjectId) {
        const setProjectId = (projectId?: string) => {
          if (!projectId) {
            return;
          }
          projectCache.set(refreshToken, projectId);
          effectiveProjectId = projectId;
        };

        const load = await requestLoadCodeAssistProjectId(accessToken, abortSignal);
        if (load.ok) {
          setProjectId(load.projectId);
        } else {
          const shouldRetryLoad =
            (load.status === 401 || load.status === 403) && !refreshedThisRequest;

          if (!shouldRetryLoad) {
            throw new Error(
              load.message ?? `Request failed with status ${load.status}`
            );
          }

          tokenCache.delete(refreshToken);
          const refreshed = await refreshAccessToken(refreshToken, preferredFlavor);
          accessToken = refreshed.accessToken;
          expiresAt = refreshed.expiresAt;
          refreshedThisRequest = true;
          cacheToken(refreshToken, accessToken, expiresAt);

          const retry = await requestLoadCodeAssistProjectId(accessToken, abortSignal);
          if (retry.ok) {
            setProjectId(retry.projectId);
          } else {
            throw new Error(
              retry.message ?? `Request failed with status ${retry.status}`
            );
          }
        }
      }

      if (!effectiveProjectId) {
        throw new Error(
          'Google Gemini requires a Google Cloud project. Enable the Gemini for Google Cloud API on a project you control, rerun `opencode auth login`, and supply that project ID when prompted.'
        );
      }

      const firstAttempt = await requestGenerateContent(
        accessToken,
        effectiveProjectId,
        model,
        normalizedQuery,
        abortSignal
      );

      if (firstAttempt.ok) {
        return formatWebSearchResponse(firstAttempt.body, normalizedQuery);
      }

      const shouldRetry =
        (firstAttempt.status === 401 || firstAttempt.status === 403) &&
        !refreshedThisRequest;

      if (!shouldRetry) {
        throw new Error(
          firstAttempt.message ?? `Request failed with status ${firstAttempt.status}`
        );
      }

      tokenCache.delete(refreshToken);
      const refreshed = await refreshAccessToken(refreshToken, preferredFlavor);
      accessToken = refreshed.accessToken;
      expiresAt = refreshed.expiresAt;
      refreshedThisRequest = true;
      cacheToken(refreshToken, accessToken, expiresAt);

      const retry = await requestGenerateContent(
        accessToken,
        effectiveProjectId,
        model,
        normalizedQuery,
        abortSignal
      );

      if (retry.ok) {
        return formatWebSearchResponse(retry.body, normalizedQuery);
      }

      throw new Error(retry.message ?? `Request failed with status ${retry.status}`);
    },
  };
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
    const text = await response.text();
    const trimmed = text.trim();
    return trimmed === '' ? undefined : trimmed;
  } catch {
    return undefined;
  }
}

function createGeminiWebSearchClient(config: GeminiClientConfig): WebSearchClient {
  return new GeminiApiKeyClient(config.apiKey, config.model);
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
    const oauthAuth = authDetails as OAuthAuthDetails;
    return createGeminiOAuthWebSearchClient(oauthAuth, model);
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
