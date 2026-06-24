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
  - `cancel`
- Shows a compact async status widget inspired by `nicobailon/pi-subagents`.
- Shows provider/model metadata in start, status, list, finish, and widget output when available.
- Resolves the child model before launch with this precedence: current parent Pi model, agent frontmatter `model`, then `settings.json` defaults.
- Keeps artifact paths in tool `details` by default; pass `verbose: true` to include debug paths in list/status text.
- Refreshes the async status widget every second while jobs are active so spinner, duration, and activity age stay current between subprocess events.
- Uses status vocabulary compatible with that representation:
  - `queued`
  - `running`
  - `complete`
  - `failed`
  - `paused`

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
---

You are a focused scout agent. Inspect the codebase and return concise findings.
```

Required fields:

- `name`
- `description`

Optional fields:

- `tools`: comma-separated Pi tools available to the child process
- `model`: model override for this child process

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

- Add true `parallel` mode with grouped status display.
- Add `chain` mode with `{previous}` handoff support.
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
