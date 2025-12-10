export const WEBSEARCH_ERROR = {
  invalidToolArguments: 'INVALID_TOOL_ARGUMENTS',
  invalidQuery: 'INVALID_QUERY',
  invalidAuth: 'INVALID_AUTH',
  invalidModel: 'INVALID_MODEL',
  webSearchFailed: 'GEMINI_WEB_SEARCH_FAILED',
} as const;

export type WebSearchErrorType = (typeof WEBSEARCH_ERROR)[keyof typeof WEBSEARCH_ERROR];

export const WEBSEARCH_ERROR_MESSAGES = {
  invalidToolArguments: 'websearch only accepts supported arguments.',
  invalidQuery: "The 'query' parameter cannot be empty.",
  invalidAuth: 'Web search is not configured: missing or invalid auth.',
  invalidModel: 'Web search is not configured: missing or invalid model.',
  webSearchFailed: 'Web search is currently unavailable.',
} as const;

export type WebSearchError = {
  message: string;
  type?: WebSearchErrorType;
};

export type GeminiChunkWeb = {
  title?: string;
  uri?: string;
};

export type GeminiChunk = {
  web?: GeminiChunkWeb;
};

export type GeminiSupportSegment = {
  startIndex?: number;
  endIndex?: number;
};

export type GeminiSupport = {
  segment?: GeminiSupportSegment;
  groundingChunkIndices?: number[];
};

export type GeminiMetadata = {
  groundingChunks?: GeminiChunk[];
  groundingSupports?: GeminiSupport[];
};

export type WebSearchResult = {
  llmContent: string;
  returnDisplay: string;
  sources?: GeminiChunk[];
  error?: WebSearchError;
};
