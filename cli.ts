import os from 'os';
import path from 'path';
import type { Hooks as PluginHooks, PluginInput } from '@opencode-ai/plugin';

import type { Auth as ProviderAuth } from '@opencode-ai/sdk';

import type { Plugin as PluginInstance } from '@opencode-ai/plugin';

type SdkConfig = Parameters<NonNullable<PluginHooks['config']>>[0];

type SdkProvider = Parameters<
  NonNullable<NonNullable<PluginHooks['auth']>['loader']>
>[1];

type CliArgs = {
  query?: string;
  config?: string;
  auth?: string;
  raw?: boolean;
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
    if (key === 'raw') {
      result.raw = true;
      index += 1;
      continue;
    }
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

function asSdkConfig(root: unknown): SdkConfig {
  if (!isRecord(root)) {
    throw new Error('Invalid opencode config: root is not an object');
  }
  return root as unknown as SdkConfig;
}

function parseProviderAuth(entry: unknown, providerID: string): ProviderAuth {
  if (!isRecord(entry)) {
    throw new Error(`Invalid auth entry for provider "${providerID}"`);
  }
  const type = entry.type;
  if (type === 'oauth') {
    const access = typeof entry.access === 'string' ? entry.access : '';
    const refresh = typeof entry.refresh === 'string' ? entry.refresh : '';
    const expires = typeof entry.expires === 'number' ? entry.expires : Number.NaN;
    if (!access || !refresh || !Number.isFinite(expires)) {
      throw new Error(`Invalid OAuth auth values for provider "${providerID}"`);
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
      throw new Error(`Invalid API key auth for provider "${providerID}"`);
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
      throw new Error(`Invalid wellknown auth for provider "${providerID}"`);
    }
    return {
      type: 'wellknown',
      key,
      token,
    };
  }

  throw new Error(
    `Unsupported auth type for provider "${providerID}": ${String(type)}`
  );
}

async function loadProviderAuth(
  filepath: string,
  providerID: string
): Promise<ProviderAuth | undefined> {
  const text = await readTextFileOrThrow(filepath);
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed)) {
    throw new Error('Invalid auth file: root is not an object');
  }
  const authFile = parsed as AuthFile;
  const entry = authFile[providerID];
  if (entry == null) {
    return undefined;
  }
  return parseProviderAuth(entry, providerID);
}

function createPluginInput(): PluginInput {
  const directory = process.cwd();
  const input: PluginInput = {
    client: {} as unknown as PluginInput['client'],
    project: {} as unknown as PluginInput['project'],
    directory,
    worktree: directory,
    $: Bun.$,
  };
  return input;
}

function createToolContext() {
  const controller = new AbortController();
  return {
    sessionID: 'cli',
    messageID: 'cli',
    agent: 'cli',
    abort: controller.signal,
  };
}

type Hooks = Awaited<ReturnType<PluginInstance>>;

type Tool = {
  execute: (args: unknown, context: unknown) => Promise<string>;
};

function isTool(value: unknown): value is Tool {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const execute = (value as Record<string, unknown>).execute;
  return typeof execute === 'function';
}

function getPluginsFromModule(mod: unknown): PluginInstance[] {
  if (!mod || typeof mod !== 'object') {
    throw new Error('Invalid plugin module');
  }

  const plugins: PluginInstance[] = [];
  for (const [name, value] of Object.entries(mod as Record<string, unknown>)) {
    if (typeof value !== 'function') {
      throw new Error(`Invalid plugin export "${name}"`);
    }
    plugins.push(value as PluginInstance);
  }

  return plugins;
}

async function initHooks(input: PluginInput): Promise<Hooks[]> {
  const mod = (await import('./index')) as unknown;
  const plugins = getPluginsFromModule(mod);
  const hooks: Hooks[] = [];
  for (const plugin of plugins) {
    hooks.push(await plugin(input));
  }
  return hooks;
}

function findTool(hooks: Hooks[], name: string): Tool | undefined {
  let found: unknown;
  for (const hook of hooks) {
    const tool = (hook.tool as Record<string, unknown> | undefined)?.[name];
    if (!tool) {
      continue;
    }
    if (found) {
      throw new Error(`Tool "${name}" registered multiple times`);
    }
    found = tool;
  }
  if (!isTool(found)) {
    return undefined;
  }
  return found;
}

async function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);

  if (!args.query || args.query.trim() === '') {
    console.error(
      'Usage: bun cli.ts --query "<text>" [--config "<path>"] [--auth "<path>"] [--raw]'
    );
    process.exit(1);
  }

  const configPath = args.config || defaultConfigPath();
  const authPath = args.auth || defaultAuthPath();

  const configRoot = await loadConfig(configPath);
  const config = asSdkConfig(configRoot);

  const input = createPluginInput();
  const hooks = await initHooks(input);

  const provider = {} as SdkProvider;

  const authCache = new Map<string, ProviderAuth>();

  for (const hook of hooks) {
    const authHook = hook.auth;
    if (!authHook?.loader) {
      continue;
    }

    const providerID = authHook.provider;
    const auth = await loadProviderAuth(authPath, providerID);
    if (!auth) {
      continue;
    }

    authCache.set(providerID, auth);

    const getAuth = (async () => {
      const cached = authCache.get(providerID);
      if (cached) {
        return cached;
      }

      const fresh = await loadProviderAuth(authPath, providerID);
      if (!fresh) {
        throw new Error(`Missing auth for provider "${providerID}"`);
      }

      authCache.set(providerID, fresh);
      return fresh;
    }) as unknown as () => Promise<ProviderAuth>;

    await authHook.loader(getAuth, provider);
  }

  for (const hook of hooks) {
    await hook.config?.(config);
  }

  const tool = findTool(hooks, 'websearch_cited');
  if (!tool) {
    throw new Error('Tool "websearch_cited" not registered');
  }

  const context = createToolContext();
  const raw = await tool.execute({ query: args.query }, context);

  if (args.raw) {
    console.log(raw);
    return;
  }

  console.log(raw);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
});
