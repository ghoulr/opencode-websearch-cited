import type { Auth as ProviderAuth } from '@opencode-ai/sdk';
import type { GetAuth, WebsearchClient } from './types.ts';

type OpenRouterPluginWeb = {
  id: 'web';
  search_prompt: string;
};

type OpenRouterResponsesRequest = {
  model: string;
  input: string;
  plugins: OpenRouterPluginWeb[];
  store: false;
  stream: false;
};

type OpenRouterUrlCitationAnnotation = {
  type?: 'url_citation';
  url?: string;
  title?: string;
  start_index?: number;
  end_index?: number;
};

type OpenRouterResponsesTextContent = {
  type?: 'output_text';
  text?: string;
  annotations?: OpenRouterUrlCitationAnnotation[];
};

type OpenRouterResponsesMessage = {
  type?: 'message';
  role?: string;
  content?: OpenRouterResponsesTextContent[];
};

type OpenRouterResponsesBody = {
  output_text?: string;
  output?: OpenRouterResponsesMessage[];
};

const OPENROUTER_RESPONSES_ENDPOINT = 'https://openrouter.ai/api/v1/responses';

function buildWebSearchUserPrompt(query: string): string {
  const normalized = query.trim();
  return `perform web search on "${normalized}". Return results with inline citations (**only** source index like [1], no URL in the answer) and end with a Sources list of URLs.`;
}

function getApiKey(auth: ProviderAuth): string {
  if (auth.type !== 'api') {
    throw new Error('OpenRouter only supports API key authentication');
  }

  const key = auth.key.trim();
  if (!key) {
    throw new Error('Missing OpenRouter API key');
  }
  return key;
}

function extractOutputText(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') {
    return undefined;
  }

  const root = payload as OpenRouterResponsesBody;

  const direct = root.output_text;
  if (typeof direct === 'string' && direct.trim() !== '') {
    return direct;
  }

  const output = root.output;
  if (!Array.isArray(output) || output.length === 0) {
    return undefined;
  }

  let combined = '';

  for (const item of output) {
    if (item.type !== 'message') {
      continue;
    }

    const content = item.content;
    if (!Array.isArray(content)) {
      continue;
    }

    for (const part of content) {
      if (part.type !== 'output_text') {
        continue;
      }

      const text = part.text;
      if (typeof text === 'string') {
        combined += text;
      }
    }
  }

  return combined || undefined;
}

async function runOpenRouterWebSearch(options: {
  model: string;
  query: string;
  abortSignal: AbortSignal;
  auth: ProviderAuth;
}): Promise<string> {
  const normalizedModel = options.model.trim();
  if (!normalizedModel) {
    throw new Error('Invalid OpenRouter web search model');
  }

  const normalizedQuery = options.query.trim();
  if (!normalizedQuery) {
    throw new Error('Query must not be empty');
  }

  const apiKey = getApiKey(options.auth);

  const body: OpenRouterResponsesRequest = {
    model: normalizedModel,
    input: buildWebSearchUserPrompt(normalizedQuery),
    plugins: [
      {
        id: 'web',
        search_prompt: buildWebSearchUserPrompt(normalizedQuery),
      },
    ],
    store: false,
    stream: false,
  };

  const response = await fetch(OPENROUTER_RESPONSES_ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: options.abortSignal,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    const details = text.trim() !== '' ? ` | responseBody=${text}` : '';
    throw new Error(
      `status=${response.status} | url=${OPENROUTER_RESPONSES_ENDPOINT} | requestBody=${JSON.stringify(
        body
      )}${details}`
    );
  }

  const payload: unknown = await response.json();
  const outputText = extractOutputText(payload);

  if (!outputText || !outputText.trim()) {
    return `Web search completed for "${normalizedQuery}", but no results were returned.`;
  }

  return outputText;
}

export function createOpenRouterWebsearchClient(model: string): WebsearchClient {
  const normalizedModel = model.trim();
  if (!normalizedModel) {
    throw new Error('Invalid OpenRouter web search model');
  }

  return {
    async search(query, abortSignal, getAuth: GetAuth) {
      const normalizedQuery = query.trim();
      if (!normalizedQuery) {
        throw new Error('Query must not be empty');
      }

      const auth = await getAuth();
      if (!auth) {
        throw new Error('Missing auth for provider "openrouter"');
      }

      return runOpenRouterWebSearch({
        model: normalizedModel,
        query: normalizedQuery,
        abortSignal,
        auth,
      });
    },
  };
}
