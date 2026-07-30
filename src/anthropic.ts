import type { Auth as ProviderAuth } from "@opencode-ai/sdk";
import type { GetAuth, WebsearchClient } from "./types.ts";

type AnthropicWebSearchTool = {
	type: "web_search_20260318";
	name: "web_search";
	max_uses: number;
	allowed_callers: ["direct"];
};

type AnthropicTextBlock = {
	type: "text";
	text: string;
};

type AnthropicUserMessage = {
	role: "user";
	content: AnthropicTextBlock[];
};

type AnthropicMessagesRequest = {
	model: string;
	max_tokens: number;
	system: AnthropicTextBlock[];
	messages: AnthropicUserMessage[];
	tools: AnthropicWebSearchTool[];
};

type AnthropicCitation = {
	type?: string;
	url?: string;
	title?: string;
};

type AnthropicContentBlock = {
	type?: string;
	text?: string;
	citations?: AnthropicCitation[] | null;
	content?: unknown;
};

export type AnthropicMessagesResponse = {
	content?: AnthropicContentBlock[];
	stop_reason?: string;
};

type AnthropicSource = {
	url: string;
	title: string;
};

type AnthropicWebSearchOptions = {
	model: string;
	query: string;
	abortSignal: AbortSignal;
	auth: ProviderAuth;
};

const ANTHROPIC_MESSAGES_ENDPOINT = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const ANTHROPIC_OAUTH_BETA = "oauth-2025-04-20";
const ANTHROPIC_MAX_TOKENS = 4096;
const ANTHROPIC_MAX_SEARCH_USES = 5;

// NOTE: Claude Code OAuth credentials require this exact first system block.
const CLAUDE_CODE_SYSTEM_PROMPT = "You are Claude Code, Anthropic's official CLI for Claude.";
const WEB_SEARCH_SYSTEM_PROMPT = "You are an AI assistant answering a single web search query for the user.";

function buildWebSearchUserPrompt(query: string): string {
	const normalized = query.trim();
	return `perform web search on "${normalized}". Answer concisely from the web search results, and do not append your own sources list.`;
}

function buildHeaders(auth: ProviderAuth): Record<string, string> {
	if (auth.type === "oauth") {
		const access = auth.access.trim();
		if (!access) {
			throw new Error("Missing Anthropic OAuth access token");
		}
		return {
			Authorization: `Bearer ${access}`,
			"anthropic-version": ANTHROPIC_VERSION,
			"anthropic-beta": ANTHROPIC_OAUTH_BETA,
			"Content-Type": "application/json",
		};
	}

	if (auth.type === "api") {
		const key = auth.key.trim();
		if (!key) {
			throw new Error("Missing Anthropic API key");
		}
		return {
			"x-api-key": key,
			"anthropic-version": ANTHROPIC_VERSION,
			"Content-Type": "application/json",
		};
	}

	throw new Error("Unsupported auth type for Anthropic web search");
}

function buildSystemBlocks(auth: ProviderAuth): AnthropicTextBlock[] {
	const searchBlock: AnthropicTextBlock = { type: "text", text: WEB_SEARCH_SYSTEM_PROMPT };
	if (auth.type !== "oauth") {
		return [searchBlock];
	}
	return [{ type: "text", text: CLAUDE_CODE_SYSTEM_PROMPT }, searchBlock];
}

function extractSearchError(content: unknown): string | undefined {
	if (!content || typeof content !== "object" || Array.isArray(content)) {
		return undefined;
	}

	const block = content as { type?: unknown; error_code?: unknown };
	if (block.type !== "web_search_tool_result_error") {
		return undefined;
	}

	const errorCode = typeof block.error_code === "string" ? block.error_code.trim() : "";
	return errorCode === "" ? "unknown" : errorCode;
}

function withCitationMarker(text: string, marker: string): string {
	if (!marker) {
		return text;
	}

	const trimmed = text.trimEnd();
	return `${trimmed}${marker}${text.slice(trimmed.length)}`;
}

function buildCitationMarker(
	citations: AnthropicCitation[] | null | undefined,
	sources: AnthropicSource[],
	indexByUrl: Map<string, number>
): string {
	if (!Array.isArray(citations) || citations.length === 0) {
		return "";
	}

	const indices: number[] = [];

	for (const citation of citations) {
		if (citation.type !== "web_search_result_location") {
			continue;
		}

		const url = typeof citation.url === "string" ? citation.url.trim() : "";
		if (!url) {
			continue;
		}

		let index = indexByUrl.get(url);
		if (index === undefined) {
			const title = typeof citation.title === "string" && citation.title.trim() !== "" ? citation.title.trim() : url;
			sources.push({ url, title });
			index = sources.length;
			indexByUrl.set(url, index);
		}

		if (!indices.includes(index)) {
			indices.push(index);
		}
	}

	return indices
		.sort((a, b) => a - b)
		.map((index) => `[${index}]`)
		.join("");
}

export function formatAnthropicWebSearchResponse(response: AnthropicMessagesResponse, query: string): string {
	const blocks = response.content;
	if (!Array.isArray(blocks) || blocks.length === 0) {
		return `Web search completed for "${query}", but no results were returned.`;
	}

	const searchResultIndex = blocks.findIndex((block) => block.type === "web_search_tool_result");
	const sources: AnthropicSource[] = [];
	const indexByUrl = new Map<string, number>();
	let searchError: string | undefined;
	let combined = "";

	for (const [position, block] of blocks.entries()) {
		if (block.type === "web_search_tool_result") {
			searchError ??= extractSearchError(block.content);
			continue;
		}

		if (block.type !== "text" || typeof block.text !== "string") {
			continue;
		}

		const isPreSearchNarration = searchResultIndex >= 0 && position < searchResultIndex;
		if (isPreSearchNarration) {
			continue;
		}

		combined += withCitationMarker(block.text, buildCitationMarker(block.citations, sources, indexByUrl));
	}

	if (!combined.trim()) {
		if (searchError) {
			throw new Error(`Anthropic web search failed: ${searchError}`);
		}
		return `Web search completed for "${query}", but no results were returned.`;
	}

	if (response.stop_reason === "max_tokens" || response.stop_reason === "pause_turn") {
		combined += `\n\n(Response truncated: stop_reason=${response.stop_reason})`;
	}

	if (sources.length === 0) {
		return combined;
	}

	const sourceLines = sources.map((source, index) => `[${index + 1}] ${source.title} (${source.url})`);
	return `${combined}\n\nSources:\n${sourceLines.join("\n")}`;
}

async function runAnthropicWebSearch(options: AnthropicWebSearchOptions): Promise<string> {
	const normalizedModel = options.model.trim();
	if (!normalizedModel) {
		throw new Error("Invalid Anthropic web search model");
	}

	const normalizedQuery = options.query.trim();
	if (!normalizedQuery) {
		throw new Error("Query must not be empty");
	}

	const body: AnthropicMessagesRequest = {
		model: normalizedModel,
		max_tokens: ANTHROPIC_MAX_TOKENS,
		system: buildSystemBlocks(options.auth),
		messages: [
			{
				role: "user",
				content: [{ type: "text", text: buildWebSearchUserPrompt(normalizedQuery) }],
			},
		],
		tools: [
			{
				type: "web_search_20260318",
				name: "web_search",
				max_uses: ANTHROPIC_MAX_SEARCH_USES,
				// NOTE: without this, the tool defaults to code execution and returns 200 with zero searches
				// and no citations whenever the caller has no code execution access.
				allowed_callers: ["direct"],
			},
		],
	};

	const response = await fetch(ANTHROPIC_MESSAGES_ENDPOINT, {
		method: "POST",
		headers: buildHeaders(options.auth),
		body: JSON.stringify(body),
		signal: options.abortSignal,
	});

	if (!response.ok) {
		const text = await response.text().catch(() => "");
		const details = text.trim() !== "" ? ` | responseBody=${text}` : "";
		throw new Error(
			`status=${response.status} | url=${ANTHROPIC_MESSAGES_ENDPOINT} | requestBody=${JSON.stringify(body)}${details}`
		);
	}

	const payload = (await response.json()) as AnthropicMessagesResponse;
	return formatAnthropicWebSearchResponse(payload, normalizedQuery);
}

export function createAnthropicWebsearchClient(model: string): WebsearchClient {
	const normalizedModel = model.trim();
	if (!normalizedModel) {
		throw new Error("Invalid Anthropic web search model");
	}

	return {
		async search(query, abortSignal, getAuth: GetAuth) {
			const normalizedQuery = query.trim();
			if (!normalizedQuery) {
				throw new Error("Query must not be empty");
			}

			const auth = await getAuth();
			if (!auth) {
				throw new Error('Missing auth for provider "anthropic"');
			}

			return runAnthropicWebSearch({
				model: normalizedModel,
				query: normalizedQuery,
				abortSignal,
				auth,
			});
		},
	};
}
