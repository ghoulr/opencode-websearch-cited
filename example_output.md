Below is a result of `websearch_cited(query='What is opencode plugin')` with GPT-5.1

An OpenCode plugin is a small JavaScript or TypeScript module that extends the OpenCode terminal AI coding agent by hooking into its events and customizing behavior. [1][3]

**What an OpenCode plugin is**

- It is a JS/TS module that exports one or more async plugin functions; each function receives a context object (project info, directory, worktree, OpenCode client, shell helper, etc.) and returns an object of hook implementations. [1]
- Plugins are used to add new features, integrate external services (e.g., auth providers, policy engines), or modify OpenCode’s default behavior when commands or tools run. [1][4][7]
- They run in‑process inside the OpenCode app, intercepting events like tool execution or commands, and can allow, deny, or augment those operations. [4][8]

**How plugins are structured and loaded**

- Plugin files live under either a project-local directory (e.g. `.opencode/plugin/` in your repo) or a global config directory (e.g. `~/.config/opencode/plugin`). OpenCode automatically discovers and loads them on startup. [1][8]
- A basic plugin looks like:

  ```ts
  // .opencode/plugin/example.ts
  import type { Plugin } from '@opencode-ai/plugin';

  export const MyPlugin: Plugin = async ({
    project,
    client,
    $,
    directory,
    worktree,
  }) => {
    console.log('Plugin initialized!');

    return {
      // hook implementations, e.g.:
      'command.executed': async (event) => {
        // react to a finished command
      },
    };
  };
  [1][4];
  ```

- The context object typically provides:
  - `project` or `app`: information about the current OpenCode project/session.
  - `client`: an SDK client for talking to the AI provider(s).
  - `$`: Bun’s shell helper for running terminal commands.
  - `directory` / `worktree`: filesystem paths for the current project. [1][4]

**Event/hook model**

- Core OpenCode plugin docs list events like `command.executed`, `file.edited`, `file.watcher.updated`, and installation-related events, which plugins can subscribe to via their returned hooks object. [1]
- Some integrations (like Cupcake) define additional semantics over tool execution with events such as `PreToolUse` and `PostToolUse`, implemented as an OpenCode plugin that gates tool calls via policy evaluation. [4][8]

**Examples in the ecosystem**

- The official ecosystem lists several named OpenCode plugins, such as: [6][7]
  - `opencode-openai-codex-auth` – an OAuth/auth plugin to use ChatGPT Plus/Pro accounts for OpenCode instead of direct API billing. [6][7]
  - `opencode-gemini-auth` – similar idea for Google Gemini plans. [6]
  - `opencode-dynamic-context-pruning` – a plugin that optimizes token usage by pruning obsolete tool outputs. [6]

These examples show that in practical terms, an “OpenCode plugin” is any module conforming to the OpenCode plugin interface that is loaded through `.opencode/plugin` and participates in the event system to extend or adjust how the OpenCode AI agent behaves.

---

Sources:<br>
[1] https://opencode.ai/docs/plugins/<br>
[2] https://thdxr.dev.opencode.ai/docs/plugins/<br>
[3] https://github.com/opencode-ai/opencode<br>
[4] https://cupcake.eqtylab.io/reference/harnesses/opencode/<br>
[5] https://cupcake.eqtylab.io/getting-started/usage/opencode/<br>
[6] https://opencode.ai/docs/ecosystem/<br>
[7] https://github.com/numman-ali/opencode-openai-codex-auth
