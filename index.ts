import { type Plugin, tool } from '@opencode-ai/plugin';
import type { Config } from '@opencode-ai/sdk';

import { createGoogleWebsearchClient } from './src/google.ts';
import {
  createOpenAIWebsearchClient,
  type OpenAIWebsearchConfig,
} from './src/openai.ts';
import { createOpenRouterWebsearchClient } from './src/openrouter.ts';
import { type GetAuth } from './src/types.ts';

const GOOGLE_PROVIDER_ID = 'google';
const OPENAI_PROVIDER_ID = 'openai';
const OPENROUTER_PROVIDER_ID = 'openrouter';

const CITED_SEARCH_TOOL_DESCRIPTION =
  'Performs a Gemini-style grounded web search: returns a concise digest with inline citations and a Sources list of URLs. NOTE: for LLM rate limits, DO NOT parallel this tool > 5';

const WEBSEARCH_ARGS = {
  query: tool.schema.string().describe('The natural language web search query.'),
} as const;

const WEBSEARCH_ALLOWED_KEYS = new Set(Object.keys(WEBSEARCH_ARGS));

const WEBSEARCH_ALLOWED_KEYS_DESCRIPTION = Array.from(WEBSEARCH_ALLOWED_KEYS)
  .map((key) => `'${key}'`)
  .join(', ');

type SelectedProviderID =
  | typeof GOOGLE_PROVIDER_ID
  | typeof OPENAI_PROVIDER_ID
  | typeof OPENROUTER_PROVIDER_ID;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

const authRegistry = new Map<string, GetAuth>();

function registerGetAuth(providerID: string, getAuth: GetAuth): void {
  authRegistry.set(providerID, getAuth);
}

function resolveGetAuth(providerID: string): GetAuth | undefined {
  return authRegistry.get(providerID);
}

type SelectedWebsearchConfig = {
  providerID: SelectedProviderID;
  model: string;
};

type WebsearchCitedSelection = {
  selected?: SelectedWebsearchConfig;
  error?: string;
};

function findFirstWebsearchCitedConfig(config: Config): WebsearchCitedSelection {
  const providers = config.provider;
  if (!providers || typeof providers !== 'object') {
    return {};
  }

  let firstError: string | undefined;

  for (const [providerID, providerConfig] of Object.entries(providers)) {
    if (!providerConfig || typeof providerConfig !== 'object') {
      continue;
    }

    const options = (providerConfig as { options?: unknown }).options;
    if (!isRecord(options)) {
      continue;
    }

    if (!('websearch_cited' in options)) {
      continue;
    }

    const cited = options.websearch_cited;
    if (!isRecord(cited)) {
      firstError ??= `Invalid websearch_cited configuration for provider "${providerID}".`;
      continue;
    }

    const candidate = cited.model;
    if (typeof candidate !== 'string' || candidate.trim() === '') {
      firstError ??= `Missing websearch_cited model for provider "${providerID}".`;
      continue;
    }

    if (
      providerID !== GOOGLE_PROVIDER_ID &&
      providerID !== OPENAI_PROVIDER_ID &&
      providerID !== OPENROUTER_PROVIDER_ID
    ) {
      firstError ??= `Unsupported provider "${providerID}" for websearch_cited.`;
      continue;
    }

    return {
      selected: {
        providerID: providerID as SelectedProviderID,
        model: candidate.trim(),
      },
    };
  }

  return firstError ? { error: firstError } : {};
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

const WebsearchCitedPlugin: Plugin = () => {
  let selectedProvider: SelectedProviderID | undefined;
  let selectedModel: string | undefined;
  let openaiConfig: OpenAIWebsearchConfig = {};
  let configError: string | undefined;

  return Promise.resolve({
    auth: {
      provider: OPENROUTER_PROVIDER_ID,
      loader(getAuth) {
        registerGetAuth(OPENROUTER_PROVIDER_ID, getAuth);
        return Promise.resolve({});
      },
      methods: [
        {
          type: 'api',
          label: 'OpenRouter API key',
        },
      ],
    },
    config: (config) => {
      const { selected, error } = findFirstWebsearchCitedConfig(config);

      selectedProvider = undefined;
      selectedModel = undefined;
      openaiConfig = {};
      configError = error;

      if (selected) {
        selectedProvider = selected.providerID;
        selectedModel = selected.model;
        if (selectedProvider === OPENAI_PROVIDER_ID) {
          const openaiProvider = config.provider?.openai;
          openaiConfig = parseOpenAIOptions(openaiProvider, selectedModel);
        }
      }

      return Promise.resolve();
    },
    tool: {
      websearch_cited: tool({
        description: CITED_SEARCH_TOOL_DESCRIPTION,
        args: WEBSEARCH_ARGS,
        async execute(args, context) {
          const argKeys = Object.keys(args ?? {});
          const extraKeys = argKeys.filter((key) => !WEBSEARCH_ALLOWED_KEYS.has(key));
          if (extraKeys.length > 0) {
            throw new Error(
              `Unknown argument(s): ${extraKeys.join(
                ', '
              )}, only ${WEBSEARCH_ALLOWED_KEYS_DESCRIPTION} supported.`
            );
          }

          const query = args.query?.trim();
          if (!query) {
            throw new Error("The 'query' parameter cannot be empty.");
          }

          if (configError) {
            throw new Error(configError);
          }

          if (!selectedProvider || !selectedModel) {
            throw new Error('Missing web search model configuration.');
          }

          if (selectedProvider === OPENAI_PROVIDER_ID) {
            const getAuth = resolveGetAuth(OPENAI_PROVIDER_ID);
            if (!getAuth) {
              throw new Error(
                'Missing auth for provider "openai". Authenticate via `opencode auth login`.'
              );
            }

            const client = createOpenAIWebsearchClient(selectedModel, openaiConfig);
            return client.search(query, context.abort, getAuth);
          }

          if (selectedProvider === OPENROUTER_PROVIDER_ID) {
            const getAuth = resolveGetAuth(OPENROUTER_PROVIDER_ID);
            if (!getAuth) {
              throw new Error(
                'Missing auth for provider "openrouter". Authenticate via `opencode auth login`.'
              );
            }

            const client = createOpenRouterWebsearchClient(selectedModel);
            return client.search(query, context.abort, getAuth);
          }

          const getAuth = resolveGetAuth(GOOGLE_PROVIDER_ID);
          if (!getAuth) {
            throw new Error(
              'Missing auth for provider "google". Authenticate via `opencode auth login`.'
            );
          }

          const client = createGoogleWebsearchClient(selectedModel);
          return client.search(query, context.abort, getAuth);
        },
      }),
    },
  });
};

export const WebsearchCitedGooglePlugin: Plugin = () => {
  return Promise.resolve({
    auth: {
      provider: GOOGLE_PROVIDER_ID,
      loader(getAuth) {
        registerGetAuth(GOOGLE_PROVIDER_ID, getAuth);
        return Promise.resolve({});
      },
      methods: [
        {
          type: 'api',
          label: 'Google API key',
        },
      ],
    },
  });
};

export const WebsearchCitedOpenAIPlugin: Plugin = () => {
  return Promise.resolve({
    auth: {
      provider: OPENAI_PROVIDER_ID,
      loader(getAuth) {
        registerGetAuth(OPENAI_PROVIDER_ID, getAuth);
        return Promise.resolve({});
      },
      methods: [
        {
          type: 'api',
          label: 'OpenAI API key',
        },
      ],
    },
  });
};

export default WebsearchCitedPlugin;
