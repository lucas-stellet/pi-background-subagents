# Diagnosis: subagent spawn `ENOENT`

## Symptom

Starting a background subagent with `cwd: "~/astride/astride-web"` terminated the parent Pi process with an uncaught exception:

```text
Error: spawn /home/lucas/.asdf/installs/nodejs/24.16.0/bin/node ENOENT
```

The persisted job is `subagent-20260716184900-d7ebd030`. Its `status.json` remains stale as `running`, with no PID, exit code, or error message.

## Reproduction

Minimal red-capable command:

```bash
CWD_VALUE='~/astride/astride-web' \
NODE_PATH='/home/lucas/.asdf/installs/nodejs/24.16.0/bin/node' \
node - <<'NODE'
const { spawn } = require('node:child_process');
const child = spawn(process.env.NODE_PATH, ['--version'], {
  cwd: process.env.CWD_VALUE,
  shell: false,
});
child.once('error', error => {
  console.log(JSON.stringify({
    code: error.code,
    syscall: error.syscall,
    path: error.path,
  }));
});
NODE
```

Observed output:

```json
{"code":"ENOENT","syscall":"spawn /home/lucas/.asdf/installs/nodejs/24.16.0/bin/node","path":"/home/lucas/.asdf/installs/nodejs/24.16.0/bin/node"}
```

The result was deterministic across three runs. Changing only `cwd` to `/home/lucas/astride/astride-web` succeeded across three runs.

## Confirmed cause

There are two contributing defects:

1. `index.ts` accepts the tool's `cwd` unchanged and passes it directly to `child_process.spawn`. Node does not perform shell tilde expansion because `shell: false`. Therefore `~/astride/astride-web` is treated as a literal relative path and does not exist.
2. `index.ts` registers `proc.on("error", ...)` only after an asynchronous status write. An immediate spawn failure can emit `error` before the listener exists, causing the parent Pi process to receive an `uncaughtException`.

The executable named in the exception is not missing: it is executable and starts successfully when given a valid absolute `cwd`. The real project directory also exists at `/home/lucas/astride/astride-web`.

## Fix status

Implemented in `index.ts`:

- The registered `subagent` tool resolves `~` and `~/...` from `os.homedir()`, resolves relative paths from `ctx.cwd`, preserves absolute inputs, and rejects named-user tilde syntax before launch.
- The tool validates the resolved path is an existing directory and returns an actionable public error containing the received and resolved values when it is not.
- `startJob` prepares its critical child listeners before calling `spawn`, attaches them synchronously immediately afterward, and waits only for the initial `spawn` or `error` outcome. Synchronous throws and immediate error events both terminalize and persist the job as `failed` before the tool responds.
- Close handling preserves an already-failed launch status, preventing a later close event from changing it to `complete`.

## Verification

- `node --test tests/subagent-spawn.test.ts` passed: 3/3 public-tool regression cases cover cwd resolution, invalid cwd rejection, and immediate missing-executable failure without an uncaught exception or stale status.
- `npm test` passed: 35/35 tests.
- `npm run check` passed.
- `git diff --check` passed.
- No temporary debug instrumentation or throwaway files remain.
