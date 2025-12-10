export type WebSearchError = {
  message: string;
  type?: string;
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
