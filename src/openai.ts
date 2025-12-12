import type { Auth as ProviderAuth } from '@opencode-ai/sdk';
import codexPrompt from './codex_prompt.md' with { type: 'text' };
import type { WebSearchResult } from './types.ts';

type OpenAIReasoningConfig = {
  effort?: string;
  summary?: string;
};

type OpenAITextConfig = {
  verbosity?: string;
};

type OpenAIInputContent = {
  type: 'input_text';
  text: string;
};

type OpenAIInputMessage = {
  role: 'user';
  content: OpenAIInputContent[];
};

type OpenAITool = {
  type: 'web_search';
};

type OpenAIResponsesRequest = {
  model: string;
  instructions: string;
  input: OpenAIInputMessage[];
  tools: OpenAITool[];
  reasoning?: OpenAIReasoningConfig;
  text?: OpenAITextConfig;
  store?: boolean;
  include?: string[];
  stream?: boolean;
  tool_choice?: string;
  parallel_tool_calls?: boolean;
};

type OpenAIWebSearchOptions = {
  model: string;
  query: string;
  abortSignal: AbortSignal;
  auth: ProviderAuth;
  reasoningEffort?: string;
  reasoningSummary?: string;
  textVerbosity?: string;
  store?: boolean;
  include?: string[];
};

function getAccessToken(auth: ProviderAuth): string {
  if (auth.type === 'oauth') {
    const access = auth.access.trim();
    if (!access) {
      throw new Error('Missing OpenAI OAuth access token');
    }
    return access;
  }

  if (auth.type === 'api') {
    const key = auth.key.trim();
    if (!key) {
      throw new Error('Missing OpenAI API key');
    }
    return key;
  }

  const token = auth.token.trim();
  if (!token) {
    throw new Error('Missing OpenAI token');
  }
  return token;
}

function extractChatGPTAccountId(auth: ProviderAuth): string | undefined {
  if (auth.type !== 'oauth') {
    return undefined;
  }

  const access = auth.access.trim();
  if (!access) {
    return undefined;
  }

  const parts = access.split('.');
  if (parts.length !== 3) {
    return undefined;
  }

  try {
    const payload = parts[1];
    if (!payload) {
      return undefined;
    }
    const decoded = Buffer.from(payload, 'base64').toString('utf8');
    const parsed = JSON.parse(decoded) as unknown;
    if (!parsed || typeof parsed !== 'object') {
      return undefined;
    }
    const root = parsed as { [key: string]: unknown };
    const claim = root['https://api.openai.com/auth'];
    if (!claim || typeof claim !== 'object') {
      return undefined;
    }
    const accountId = (claim as { chatgpt_account_id?: unknown }).chatgpt_account_id;
    if (typeof accountId !== 'string') {
      return undefined;
    }
    const trimmed = accountId.trim();
    return trimmed === '' ? undefined : trimmed;
  } catch {
    return undefined;
  }
}

export async function runOpenAIWebSearch(
  options: OpenAIWebSearchOptions
): Promise<WebSearchResult> {
  const normalizedModel = options.model.trim();
  if (!normalizedModel) {
    throw new Error('Invalid OpenAI web search model');
  }

  const normalizedQuery = options.query.trim();
  if (!normalizedQuery) {
    throw new Error('Query must not be empty');
  }

  const accessToken = getAccessToken(options.auth);
  const isOAuth = options.auth.type === 'oauth';

  const body: OpenAIResponsesRequest = {
    model: normalizedModel,
    instructions: '',
    input: [
      {
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: normalizedQuery,
          },
        ],
      },
    ],
    tools: [{ type: 'web_search' }],
  };

  if (options.reasoningEffort || options.reasoningSummary) {
    body.reasoning = {
      effort: options.reasoningEffort,
      summary: options.reasoningSummary,
    };
  }

  if (options.textVerbosity) {
    body.text = {
      verbosity: options.textVerbosity,
    };
  }

  if (typeof options.store === 'boolean') {
    body.store = options.store;
  }

  if (Array.isArray(options.include) && options.include.length > 0) {
    const filtered = options.include.filter(
      (value) => typeof value === 'string' && value.trim() !== ''
    );
    if (filtered.length > 0) {
      body.include = filtered;
    }
  }

  body.stream = true;
  body.tool_choice = 'auto';
  body.parallel_tool_calls = true;

  if (isOAuth) {
    body.instructions = codexPrompt;
  } else {
    body.instructions =
      'You are an AI assistant answering a single web search query for the user.';
  }

  const url = isOAuth
    ? 'https://chatgpt.com/backend-api/codex/responses'
    : 'https://api.openai.com/v1/responses';

  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    'OpenAI-Beta': 'responses=experimental',
  };

  if (isOAuth) {
    const accountId = extractChatGPTAccountId(options.auth);
    if (accountId) {
      headers['chatgpt-account-id'] = accountId;
    }
    headers.originator = 'codex_cli_rs';
  }

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: options.abortSignal,
  });

  if (!response.ok) {
    const message = await buildErrorDetails(response, url, body);
    throw new Error(message);
  }

  const payload = await readOpenAIResponsePayload(response);
  const text = extractOpenAIText(payload);

  if (!text || !text.trim()) {
    const fallback = `Web search completed for "${normalizedQuery}", but no results were returned.`;
    return {
      llmContent: fallback,
      returnDisplay: 'Web search did not return any content.',
    };
  }

  const llmContent = `Web search results for "${normalizedQuery}":\n\n${text}`;
  return {
    llmContent,
    returnDisplay: `Search results for "${normalizedQuery}" returned.`,
  };
}

function extractOpenAIText(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') {
    return undefined;
  }

  const root = payload as { output?: unknown };
  const output = root.output;
  if (!Array.isArray(output) || output.length === 0) {
    return undefined;
  }

  let combined = '';

  for (const item of output) {
    if (!item || typeof item !== 'object') {
      continue;
    }

    const content = (item as { content?: unknown }).content;
    if (!Array.isArray(content)) {
      continue;
    }

    for (const part of content) {
      if (!part || typeof part !== 'object') {
        continue;
      }

      const kind = (part as { type?: unknown }).type;
      if (kind !== 'output_text') {
        continue;
      }

      const textField = (part as { text?: unknown }).text;
      if (typeof textField === 'string') {
        combined += textField;
      } else if (textField && typeof textField === 'object') {
        const obj = textField as { value?: unknown };
        if (typeof obj.value === 'string') {
          combined += obj.value;
        }
      }
    }
  }

  return combined || undefined;
}

async function buildErrorDetails(
  response: Response,
  url: string,
  body: OpenAIResponsesRequest
): Promise<string> {
  const parts: string[] = [];
  parts.push(`status=${response.status}`);
  parts.push(`url=${url}`);
  const safeBody: OpenAIResponsesRequest = { ...body };
  if (typeof safeBody.instructions === 'string') {
    const value = safeBody.instructions;
    const maxLength = 512;
    if (value.length > maxLength) {
      const headLength = 256;
      const tailLength = 128;
      const head = value.slice(0, headLength);
      const tail = value.slice(-tailLength);
      const omitted = value.length - headLength - tailLength;
      safeBody.instructions = `${head} ... [${omitted} chars truncated] ... ${tail}`;
    }
  }
  parts.push(`requestBody=${JSON.stringify(safeBody)}`);

  let rawText: string | undefined;
  try {
    rawText = await response.text();
  } catch {}

  if (rawText) {
    let parsedMessage: string | undefined;
    try {
      const parsed = JSON.parse(rawText) as { error?: { message?: unknown } };
      const message = parsed.error?.message;
      if (typeof message === 'string' && message.trim() !== '') {
        parsedMessage = message.trim();
      }
    } catch {}

    if (parsedMessage) {
      parts.unshift(`error=${parsedMessage}`);
    }

    parts.push(`responseBody=${rawText}`);
  }

  return parts.join(' | ');
}

type OpenAISseEvent = {
  type?: string;
  response?: object;
};

async function readOpenAIResponsePayload(response: Response): Promise<unknown> {
  const text = await response.text();
  const trimmed = text.trim();
  if (trimmed === '') {
    return {};
  }

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      return parsed;
    } catch {
      // fall through to SSE parsing
    }
  }

  const extracted = extractOpenAIResponseFromSse(text);
  if (extracted !== undefined) {
    return extracted;
  }

  throw new Error('Failed to parse JSON');
}

function extractOpenAIResponseFromSse(sseText: string): object | undefined {
  const lines = sseText.split('\n');

  for (const line of lines) {
    if (!line.startsWith('data: ')) {
      continue;
    }
    const payload = line.slice(6).trim();
    if (!payload || payload === '[DONE]') {
      continue;
    }
    try {
      const parsed = JSON.parse(payload) as OpenAISseEvent;
      const kind = parsed.type ?? '';
      if (kind === 'response.done' || kind === 'response.completed') {
        return parsed.response;
      }
    } catch {}
  }

  return undefined;
}
