# Pi Background Subagents

A minimal Pi extension for running delegated subagents in the background.

This project started from Pi's official `examples/extensions/subagent` example and keeps the same Markdown agent format, but changes the execution model: every subagent is started asynchronously, writes artifacts to the OS temp directory, and notifies the parent Pi session when it finishes.

## Current status

Implemented:

- Registers a `subagent` tool.
- Starts subagents in the background with isolated Pi processes.
- Loads agents from:
  - `~/.pi/agent/agents/*.md`
  - nearest project `.pi/agents/*.md` when `agentScope` is `project` or `both`
- Persists job artifacts under:

  ```text
  os.tmpdir()/pi-subagents/<parent-session-id>/<job-id>/
  ```

- Writes these artifacts per job:

  ```text
  task.json
  status.json
  stdout.jsonl
  stderr.log
  messages.json
  result.md
  system-prompt-<agent>.md
  ```

- Sends a follow-up user message to the parent agent when a job finishes.
- Supports management actions:
  - `start`
  - `status`
  - `result`
  - `list`
  - `list-agents`
  - `cancel`
- Shows a compact async status widget inspired by `nicobailon/pi-subagents`.
- Shows provider/model metadata in start, status, list, finish, and widget output when available.
- Respects prompt/context frontmatter:
  - `systemPromptMode: replace` uses `--system-prompt` so the child does not inherit Pi's default system prompt.
  - `systemPromptMode: append` uses `--append-system-prompt`.
  - `inheritProjectContext: false` passes `--no-context-files`.
  - `inheritSkills: false` passes `--no-skills`.
- Resolves the child model before launch with this precedence: agent frontmatter `model`, `settings.json` subagent override, `settings.json` defaults, then current parent Pi model.
- Keeps artifact paths in tool `details` by default; pass `verbose: true` to include debug paths in list/status text.
- Refreshes the async status widget every second while jobs are active so spinner, duration, and activity age stay current between subprocess events.
- Uses status vocabulary compatible with that representation:
  - `queued`
  - `running`
  - `complete`
  - `failed`
  - `paused`
  - `cancelled`

## Installation

### As a local Pi package

From this directory:

```bash
pi install ./
```

Or add this package path to your Pi settings manually.

### As a development extension

Symlink into Pi's global extension directory:

```bash
mkdir -p ~/.pi/agent/extensions/background-subagents
ln -sf "$PWD/index.ts" ~/.pi/agent/extensions/background-subagents/index.ts
ln -sf "$PWD/agents.ts" ~/.pi/agent/extensions/background-subagents/agents.ts
```

Then reload Pi:

```text
/reload
```

> Note: this extension registers a tool named `subagent`. Disable other packages that register the same tool name while testing, such as `npm:pi-subagents`.

## Agent format

Agents are Markdown files with YAML frontmatter:

```markdown
---
name: scout
description: Fast codebase reconnaissance
tools: read, grep, find, ls, bash
model: anthropic/claude-haiku-4-5
systemPromptMode: replace
inheritProjectContext: true
inheritSkills: false
---

You are a focused scout agent. Inspect the codebase and return concise findings.
```

Required fields:

- `name`
- `description`

Optional fields:

- `tools`: comma-separated Pi tools available to the child process
- `model`: model override for this child process
- `systemPromptMode`: `append` by default, or `replace` to use this agent prompt instead of Pi's default system prompt
- `inheritProjectContext`: `true` by default; when `false`, launches the child with `--no-context-files`
- `inheritSkills`: `true` by default; when `false`, launches the child with `--no-skills`

## Tool usage

Start a job:

```json
{
  "action": "start",
  "agent": "scout",
  "task": "Find the authentication entry points."
}
```

List jobs for the current parent session:

```json
{
  "action": "list"
}
```

List available agents, including each agent's prompt mode, project context inheritance, skills inheritance, model, and tools:

```json
{
  "action": "list-agents",
  "agentScope": "both"
}
```

Include agent file paths:

```json
{
  "action": "list-agents",
  "agentScope": "both",
  "verbose": true
}
```

Show active job status:

```json
{
  "action": "status"
}
```

Inspect one job:

```json
{
  "action": "status",
  "jobId": "subagent-..."
}
```

Include debug artifact paths in list/status output:

```json
{
  "action": "status",
  "jobId": "subagent-...",
  "verbose": true
}
```

Read a completed result:

```json
{
  "action": "result",
  "jobId": "subagent-..."
}
```

Cancel a running job:

```json
{
  "action": "cancel",
  "jobId": "subagent-..."
}
```

Cancelled jobs are marked `cancelled` and removed from the live widget and default run lists.

## Chains

Chains are YAML workflows discovered from:

- `~/.pi/agent/chains/*.chain.yaml` (or `.chain.yml`)
- nearest project `.pi/chains/*.chain.yaml` (or `.chain.yml`) when chain scope includes project chains

Example chain file:

```yaml
name: review-fix
description: Investigate and fix reviewer feedback
stages:
  - id: inspect
    agent: scout
    model: deepseek/deepseek-v4-flash
    output: inspect.md
    prompt: |
      Review the task and codebase.

      # Findings
      Summarize blockers for: {task}

  - id: fix
    agent: coder
    model: openai-codex/gpt-5.5
    reads:
      - inspect.md
    output: fix.md
    prompt: |
      Use the inspection notes and implement the smallest fix.
```

Every chain phase must declare `model: provider/model`; chain execution does not fall back to agent frontmatter, settings defaults, or the parent model. Stages run sequentially by default. A stage may set `mode: parallel` and contain `phases:`; phases in that stage run concurrently as the current parallel MVP, then later stages can read their declared outputs. Phase prompts may include `{task}`, which is replaced with the original chain task. If omitted, the original task is appended to the phase prompt.

Run or inspect chains with the `chain` tool:

```json
{ "action": "list", "chainScope": "both" }
```

```json
{ "action": "start", "chain": "review-fix", "task": "Fix the reviewer blockers." }
```

```json
{ "action": "status", "chainId": "chain-...", "verbose": true }
```

```json
{ "action": "result", "chainId": "chain-..." }
```

Failed chains can be resumed after fixing the cause:

```json
{ "action": "resume", "chainId": "chain-..." }
```

Chain outputs are stored under the chain run artifacts directory and must be declared with `output` or `outputs`. Phases that declare `reads` can access prior outputs through the chain tools.

## Project-local agent confirmation

Project-local agents run without an interactive confirmation by default. To opt back into the trust prompt for a specific call, pass:

```json
{
  "confirmProjectAgents": true
}
```

## Runtime behavior

A child agent is launched with a separate Pi process roughly equivalent to:

```bash
pi --mode json -p --no-session \
  --model <agent-model> \
  --tools <agent-tools> \
  --append-system-prompt <agent-system-prompt-file> \
  "Task: <task>"
```

The parent extension reads the JSON event stream, updates `status.json`, stores the final assistant output in `result.md`, and sends a parent-session follow-up message when the process exits.

## Roadmap

Planned improvements:

- Improve chain parallel status grouping and live progress display.
- Add optional chain shortcuts such as `reads: previous` / `reads: all`.
- Add richer TUI rendering for `renderCall` and `renderResult`.
- Track recent tool calls and recent output snippets in status files.
- Add stale-process reconciliation after parent Pi restarts.
- Add job retention/cleanup policy for temp artifacts.
- Add optional project-local builtin agents.
- Add tests for agent discovery, status formatting, and job lifecycle.
- Publish as an npm Pi package.

## Development notes

This package follows Pi package conventions with a `pi` manifest in `package.json`:

```json
{
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./index.ts"]
  }
}
```

Pi core packages are listed as peer dependencies because Pi provides them at runtime.
