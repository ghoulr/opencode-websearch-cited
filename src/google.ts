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

type RefreshedToken = {
  accessToken: string;
  expiresAt: number;
};

interface WebSearchClient {
  search(query: string, abortSignal: AbortSignal): Promise<string>;
}

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const ANTIGRAVITY_ENDPOINT_DAILY = 'https://daily-cloudcode-pa.sandbox.googleapis.com';
const ANTIGRAVITY_ENDPOINT_AUTOPUSH =
  'https://autopush-cloudcode-pa.sandbox.googleapis.com';
const ANTIGRAVITY_ENDPOINT_PROD = 'https://cloudcode-pa.googleapis.com';
const GEMINI_CODE_ASSIST_GENERATE_PATH = '/v1internal:generateContent';
const GEMINI_CODE_ASSIST_LOAD_PATH = '/v1internal:loadCodeAssist';
const CODE_ASSIST_GENERATE_ENDPOINTS = [
  ANTIGRAVITY_ENDPOINT_DAILY,
  ANTIGRAVITY_ENDPOINT_AUTOPUSH,
  ANTIGRAVITY_ENDPOINT_PROD,
] as const;
const CODE_ASSIST_LOAD_ENDPOINTS = [
  ANTIGRAVITY_ENDPOINT_PROD,
  ANTIGRAVITY_ENDPOINT_DAILY,
  ANTIGRAVITY_ENDPOINT_AUTOPUSH,
] as const;
const ANTIGRAVITY_DEFAULT_PROJECT_ID = 'rising-fact-p41fc';
const OAUTH_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

const ANTIGRAVITY_CLIENT_ID =
  '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com';
const ANTIGRAVITY_CLIENT_SECRET = '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';

const REFRESH_BUFFER_MS = 60_000;

const CODE_ASSIST_HEADERS = {
  'User-Agent': 'antigravity/1.11.5 windows/amd64',
  'X-Goog-Api-Client': 'google-cloud-sdk vscode_cloudshelleditor/0.1',
  'Client-Metadata':
    '{"ideType":"IDE_UNSPECIFIED","platform":"PLATFORM_UNSPECIFIED","pluginType":"GEMINI"}',
} as const;

const tokenCache = new Map<string, { accessToken: string; expiresAt: number }>();
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

async function requestToken(refreshToken: string): Promise<RefreshedToken> {
  const requestTime = Date.now();
  const response = await fetch(OAUTH_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: ANTIGRAVITY_CLIENT_ID,
      client_secret: ANTIGRAVITY_CLIENT_SECRET,
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
  const expiresIn =
    typeof payload.expires_in === 'number' && Number.isFinite(payload.expires_in)
      ? payload.expires_in
      : 3600;
  const expiresAt = expiresIn > 0 ? requestTime + expiresIn * 1000 : requestTime;

  return {
    accessToken: payload.access_token,
    expiresAt,
  };
}

async function refreshAccessToken(refreshToken: string): Promise<RefreshedToken> {
  const result = await requestToken(refreshToken);
  cacheToken(refreshToken, result.accessToken, result.expiresAt);
  return result;
}

type LoadCodeAssistPayload = {
  cloudaicompanionProject?: string | { id?: string };
};

function buildMetadata(projectId?: string): Record<string, string> {
  const metadata: Record<string, string> = {
    ideType: 'IDE_UNSPECIFIED',
    platform: 'PLATFORM_UNSPECIFIED',
    pluginType: 'GEMINI',
  };
  if (projectId) {
    metadata.duetProject = projectId;
  }
  return metadata;
}

async function loadManagedProject(
  accessToken: string,
  projectId: string | undefined,
  abortSignal: AbortSignal
): Promise<LoadCodeAssistPayload | null> {
  const loadHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${accessToken}`,
    'User-Agent': 'google-api-nodejs-client/9.15.1',
    'X-Goog-Api-Client': 'google-cloud-sdk vscode_cloudshelleditor/0.1',
    'Client-Metadata': CODE_ASSIST_HEADERS['Client-Metadata'],
  };

  const requestBody = {
    metadata: buildMetadata(projectId),
  };

  const loadEndpoints = Array.from(
    new Set<string>([...CODE_ASSIST_LOAD_ENDPOINTS, ...CODE_ASSIST_GENERATE_ENDPOINTS])
  );

  for (const baseEndpoint of loadEndpoints) {
    try {
      const response = await fetch(`${baseEndpoint}${GEMINI_CODE_ASSIST_LOAD_PATH}`, {
        method: 'POST',
        headers: loadHeaders,
        body: JSON.stringify(requestBody),
        signal: abortSignal,
      });

      if (!response.ok) {
        continue;
      }

      return (await response.json()) as LoadCodeAssistPayload;
    } catch {
      continue;
    }
  }

  return null;
}

function extractManagedProjectId(
  payload?: LoadCodeAssistPayload | null
): string | undefined {
  if (!payload) {
    return undefined;
  }
  const project = payload.cloudaicompanionProject;
  if (typeof project === 'string' && project.trim() !== '') {
    return project;
  }
  if (project && typeof project === 'object' && project.id) {
    const id = project.id;
    if (typeof id === 'string' && id.trim() !== '') {
      return id;
    }
  }
  return undefined;
}

async function resolveProjectId(
  accessToken: string,
  refreshToken: string,
  refreshParts: RefreshParts,
  abortSignal: AbortSignal
): Promise<string> {
  if (refreshParts.managedProjectId) {
    return refreshParts.managedProjectId;
  }

  const cached = projectCache.get(refreshToken);
  if (cached) {
    return cached;
  }

  const fallbackProjectId = ANTIGRAVITY_DEFAULT_PROJECT_ID;
  const desiredProjectId = refreshParts.projectId ?? fallbackProjectId;
  const loadPayload = await loadManagedProject(
    accessToken,
    desiredProjectId,
    abortSignal
  );
  const resolvedManagedProjectId = extractManagedProjectId(loadPayload);

  if (resolvedManagedProjectId) {
    projectCache.set(refreshToken, resolvedManagedProjectId);
    return resolvedManagedProjectId;
  }

  if (refreshParts.projectId) {
    return refreshParts.projectId;
  }

  return fallbackProjectId;
}

function parseExpires(expires: unknown): number | undefined {
  if (typeof expires === 'number' && Number.isFinite(expires)) {
    return expires;
  }
  return undefined;
}

function accessTokenExpired(accessToken: string, expiresAt?: number): boolean {
  if (!accessToken || typeof expiresAt !== 'number') {
    return true;
  }
  return expiresAt <= Date.now() + REFRESH_BUFFER_MS;
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
  const requestPayload: Record<string, unknown> = {
    contents: [
      {
        role: 'user',
        parts: [{ text: query }],
      },
    ],
    tools: [{ googleSearch: {} }],
  };

  const body = JSON.stringify({
    project: projectId,
    model,
    request: requestPayload,
    requestType: 'agent',
    userAgent: 'antigravity',
    requestId: `agent-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`,
  });

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${accessToken}`,
    'User-Agent': CODE_ASSIST_HEADERS['User-Agent'],
    'X-Goog-Api-Client': CODE_ASSIST_HEADERS['X-Goog-Api-Client'],
    'Client-Metadata': CODE_ASSIST_HEADERS['Client-Metadata'],
  };

  let lastError: { status: number; message?: string } | undefined;

  for (const baseUrl of CODE_ASSIST_GENERATE_ENDPOINTS) {
    const response = await fetch(`${baseUrl}${GEMINI_CODE_ASSIST_GENERATE_PATH}`, {
      method: 'POST',
      headers,
      body,
      signal: abortSignal,
    });

    if (!response.ok) {
      const message = await readErrorMessage(response);
      if (response.status === 401 || response.status === 403) {
        return { ok: false, status: response.status, message };
      }
      lastError = { status: response.status, message };
      continue;
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

  if (lastError) {
    return { ok: false, status: lastError.status, message: lastError.message };
  }

  return {
    ok: false,
    status: 502,
    message: 'Request failed for all Google Code Assist endpoints.',
  };
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

      const cached = getCachedAccess(refreshToken);
      let accessToken = cached?.accessToken ?? initialAccess;
      let expiresAt = cached?.expiresAt ?? initialExpires;
      let refreshedThisRequest = false;

      if (accessTokenExpired(accessToken, expiresAt)) {
        const refreshed = await refreshAccessToken(refreshToken);
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

      const effectiveProjectId = await resolveProjectId(
        accessToken,
        refreshToken,
        refreshParts,
        abortSignal
      );

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
      const refreshed = await refreshAccessToken(refreshToken);
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
