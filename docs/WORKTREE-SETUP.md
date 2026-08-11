# Worktree setup commands

Every task gets a fresh `git worktree`, which means a fresh, empty
`node_modules` / `.venv` / `vendor`. The setup command is what fills it in
before the implementation agent starts, so the agent's first test run isn't
a cascade of "cannot find module".

## Configuring it

Per project, in `config/projects.json` (or the "Setup command" field when
registering a project in the UI):

```json
{
  "name": "vergil",
  "repoPath": "~/Documents/projects/vergil/",
  "setupCommand": "pnpm install --frozen-lockfile"
}
```

A global fallback for projects that don't set one lives in
`config/autocode.json`:

```json
"setup": {
  "defaultCommand": null,
  "timeoutMs": 900000
}
```

Resolution is `projects.setup_command ?? setup.defaultCommand`. If both are
null, setup is skipped entirely and the task goes straight to `implementing`.

The command is a shell line, run with `bash -lc` in the worktree root, so
`&&`, environment variables, and version managers that need a login shell to
put `pnpm`/`uv` on `PATH` all work. Examples: `pnpm install --frozen-lockfile`,
`uv sync`, `bundle install && bin/rails db:prepare`, `make deps`.

## What happens during a run

1. `POST /api/plans/:id/implement` creates the worktree and the
   implementation run row, then returns `202` immediately — a cold install
   takes minutes.
2. The task sits in `setting_up`. The setup command's output streams into
   the run's `run_log` (`setup_output` / `setup_status` events), so it shows
   up live in the UI's "Environment setup" card over the same SSE connection
   that carries the rest of the run.
3. On success, the task moves to `implementing` and the agent starts in the
   already-provisioned worktree.
4. On failure (non-zero exit, or the `timeoutMs` cap), **the agent never
   starts**: the run and the task are marked `failed`, and the captured
   output is kept on the worktree row. Handing a model a worktree with no
   dependencies just burns the run's budget on failures it can't diagnose.

The tail of the output (last 64KB) is stored in `worktrees.setup_output`
alongside `setup_status`, `setup_exit_code`, and the timestamps.

## Trust model

The setup command is **not** filtered by the rule engine and **not** run in
the SDK sandbox — the same standing as a devcontainer `postCreateCommand`.
Two reasons this is deliberate:

- It's a line the operator wrote in their own config file. The agent never
  produces or influences it.
- Installing dependencies means unrestricted access to package registries,
  which is exactly what the agent-facing network allowlist exists to prevent.
  Running it under the agent's sandbox would mean either failing every
  install or punching a hole big enough to make the allowlist meaningless.

Anything the *agent* runs afterwards — including its own `pnpm install` if
it decides it needs one — goes through the normal filter and asks the user.

The command runs with `scrubbedEnv()` (see `src/agent/env.ts`), so API-key
environment variables aren't handed to it.

## Timeouts

`setup.timeoutMs` (default 15 min) is enforced by killing the whole process
*group*, not just the `bash` process — installers that spawn daemons or
background workers would otherwise survive and leak.
