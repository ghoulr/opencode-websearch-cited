Default to using Bun instead of Node.js

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Check `node_modules/bun-types/docs/**.md` for bun API before use any node API
- Bun automatically loads .env, so don't use dotenv

## Project scope

This repository contains an OpenCode plugin that exposes a Gemini-backed web search capability as a custom tool

- The primary tool is `websearch_gemini`
- The tool uses `@google/genai` to call a Gemini model configured with the `googleSearch` tool
- The tool returns markdown output with inline citations and a sources list

## Coding and implementation

- Keep the implementation minimal and focused on the `websearch_gemini` tool
- Prefer small, single-purpose functions
- Since we are building a plugin, minimal dependencies will be a better design choice
- Let errors propagate instead of swallowing them, follow the `fast fail` principal, let callers to deal with the error
- Do not add comments in code, logs, or exceptions beyond what is strictly necessary
- We must NEVER have type any anywhere, unless absolutely, positively necessary
- If you are working with an external API, check node_modules for the type definitions as needed instead of assuming things
- After any change, use `bun check` to pass `eslint` and `tsc`

## Testing

Use `bun test:agent` to run tests, this is specific for agents
