import os from 'os';
import path from 'path';
import { runOpenAIWebSearch } from './src/openai.ts';
import type { Auth as ProviderAuth } from '@opencode-ai/sdk';

type CliArgs = {
  query?: string;
  model?: string;
  config?: string;
  auth?: string;
};

type OpenAIConfig = {
  model: string;
  reasoningEffort?: string;
  reasoningSummary?: string;
  textVerbosity?: string;
  store?: boolean;
  include?: string[];
};

type AuthFile = {
  [providerID: string]: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function parseArgs(argv: string[]): CliArgs {
  const result: CliArgs = {};
  let index = 0;
  while (index < argv.length) {
    const token = argv[index] ?? '';
    if (!token.startsWith('--')) {
      index += 1;
      continue;
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      if (key === 'query') {
        result.query = '';
      }
      index += 1;
      continue;
    }
    if (key === 'query') {
      result.query = next;
    } else if (key === 'model') {
      result.model = next;
    } else if (key === 'config') {
      result.config = next;
    } else if (key === 'auth') {
      result.auth = next;
    }
    index += 2;
  }
  return result;
}

function defaultConfigPath(): string {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'opencode', 'opencode.jsonc');
}

function defaultAuthPath(): string {
  const base = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(base, 'opencode', 'auth.json');
}

async function readTextFileOrThrow(filepath: string): Promise<string> {
  const file = Bun.file(filepath);
  if (!(await file.exists())) {
    throw new Error(`File not found: ${filepath}`);
  }
  return file.text();
}

function stripJsoncComments(text: string): string {
  const lines = text.split('\n');
  const kept: string[] = [];
  for (const line of lines) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith('//')) {
      continue;
    }
    kept.push(line);
  }
  return kept.join('\n');
}

async function loadConfig(filepath: string): Promise<unknown> {
  const raw = await readTextFileOrThrow(filepath);
  const cleaned = stripJsoncComments(raw);
  const parsed: unknown = JSON.parse(cleaned);
  return parsed;
}

function extractOpenAIConfig(root: unknown, overrideModel?: string): OpenAIConfig {
  if (!isRecord(root)) {
    throw new Error('Invalid opencode config: root is not an object');
  }
  const provider = root.provider;
  if (!isRecord(provider)) {
    throw new Error('Invalid opencode config: provider block missing');
  }
  const openai = provider.openai;
  if (!isRecord(openai)) {
    throw new Error('Invalid opencode config: provider.openai missing');
  }

  const options = isRecord(openai.options) ? openai.options : undefined;
  const models = isRecord(openai.models) ? openai.models : undefined;

  const baseModel = (() => {
    if (overrideModel && overrideModel.trim() !== '') {
      return overrideModel.trim();
    }
    if (!options) {
      return undefined;
    }
    const grounded = options.websearch_grounded;
    if (!isRecord(grounded)) {
      return undefined;
    }
    const candidate = grounded.model;
    if (typeof candidate !== 'string') {
      return undefined;
    }
    const trimmed = candidate.trim();
    return trimmed === '' ? undefined : trimmed;
  })();

  const model = baseModel ?? 'gpt-5.1';

  const baseOptions = options ?? {};
  let modelOptions: Record<string, unknown> = {};
  if (models && models[model] && isRecord(models[model])) {
    const entry = models[model] as { options?: unknown };
    if (isRecord(entry.options)) {
      modelOptions = entry.options;
    }
  }

  const merged: Record<string, unknown> = {
    ...baseOptions,
    ...modelOptions,
  };

  const result: OpenAIConfig = { model };

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
    ) as string[];
    if (filtered.length > 0) {
      result.include = filtered;
    }
  }

  return result;
}

async function loadOpenAIAuth(filepath: string): Promise<ProviderAuth> {
  const text = await readTextFileOrThrow(filepath);
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed)) {
    throw new Error('Invalid auth file: root is not an object');
  }
  const authFile = parsed as AuthFile;
  const entry = authFile.openai;
  if (!isRecord(entry)) {
    throw new Error('Auth for provider "openai" not found in auth file');
  }
  const type = entry.type;
  if (type === 'oauth') {
    const access = typeof entry.access === 'string' ? entry.access : '';
    const refresh = typeof entry.refresh === 'string' ? entry.refresh : '';
    const expires = typeof entry.expires === 'number' ? entry.expires : Number.NaN;
    if (!access || !refresh || !Number.isFinite(expires)) {
      throw new Error('Invalid OAuth auth values for provider "openai"');
    }
    return {
      type: 'oauth',
      access,
      refresh,
      expires,
    };
  }
  if (type === 'api') {
    const key = typeof entry.key === 'string' ? entry.key : '';
    if (!key) {
      throw new Error('Invalid API key auth for provider "openai"');
    }
    return {
      type: 'api',
      key,
    };
  }
  if (type === 'wellknown') {
    const key = typeof entry.key === 'string' ? entry.key : '';
    const token = typeof entry.token === 'string' ? entry.token : '';
    if (!key || !token) {
      throw new Error('Invalid wellknown auth for provider "openai"');
    }
    return {
      type: 'wellknown',
      key,
      token,
    };
  }

  throw new Error(`Unsupported auth type for openai: ${String(type)}`);
}

async function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);

  if (!args.query || args.query.trim() === '') {
    console.error(
      'Usage: bun cli.ts --query "<text>" [--model "<model>"] [--config "<path>"] [--auth "<path>"]'
    );
    process.exit(1);
  }

  const configPath = args.config || defaultConfigPath();
  const authPath = args.auth || defaultAuthPath();

  const configRoot = await loadConfig(configPath);
  const openaiConfig = extractOpenAIConfig(configRoot, args.model);
  const auth = await loadOpenAIAuth(authPath);

  const controller = new AbortController();

  const result = await runOpenAIWebSearch({
    model: openaiConfig.model,
    query: args.query,
    abortSignal: controller.signal,
    auth,
    reasoningEffort: openaiConfig.reasoningEffort,
    reasoningSummary: openaiConfig.reasoningSummary,
    textVerbosity: openaiConfig.textVerbosity,
    store: openaiConfig.store,
    include: openaiConfig.include,
  });

  console.log(result.llmContent);
}

main().catch((error) => {
  console.error('Error running OpenAI web search CLI.', error);
  process.exit(1);
});
