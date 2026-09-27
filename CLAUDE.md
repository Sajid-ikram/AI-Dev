# aidev

A personal tool that picks up Jira tickets and sends each one to a worker agent, which implements it in a sandbox. An independent reviewer agent then verifies the work, and the tool opens a Bitbucket pull request. It works on any project through a per-project config file. For now it runs on the owner's Windows PC, and the tool's own source is hosted on GitHub at https://github.com/Sajid-ikram/AI-Dev (a public repo, so nothing private goes in committed files).

## Status

- Phase 0 code is written and tested: `aidev build`, `aidev run <KEY>` and `aidev sandbox-test` (usage in README.md). `aidev run` was tested end to end with a stand-in `claude` script, `aidev sandbox-test` passes on every image, and potato-proto's checks pass in `aidev-flutter` (about 30 s over the Windows bind mount).
- Phase 0's done test passed on 2026-09-27: in `aidev sandbox-test --agent`, Claude (Opus 5.5, on the subscription token) tried every route it could find and couldn't list `C:\Users`.
- Left in Phase 0: one `aidev run` on a real potato-proto ticket (from Jira or `--ticket-file`).
- potato-proto is a private Bitbucket repo; its URL is in the gitignored `projects/potato-proto.yaml`. The Flutter app is on `main`, in `app/`. On 2026-09-27 the workspace was briefly read-only (the push returned HTTP 402 "exceeded its user limit"). It became writable again the same day, and the repository access token pushed the app.
- `.env` is filled in except `JIRA_BASE_URL`, which still has the example value. The Jira project key (`jiraProject`, a guess of `POT`) isn't confirmed.
- The worker defaults to Opus, with Sonnet as the fallback when Opus is overloaded. On the owner's subscription, Fable needs paid usage credits (the API answers `credits_required`), so it's opt-in per project.
- The local `potato-proto/` folder is the owner's working copy and a *target* project, not part of the tool, so it stays out of the tool's git repo. A demo Node.js project will be added later, also on Bitbucket. The tool always clones from Bitbucket; agents never work in the owner's own copies.

## Decisions (and why)

- **Agents run as the Claude Code CLI (`claude -p`), not through the Agent SDK library.** Auth uses the owner's Claude subscription through `CLAUDE_CODE_OAUTH_TOKEN`, a one-year token from `claude setup-token`. The Agent SDK docs say third-party products must not offer claude.ai login, and the SDK path expects API keys. `claude -p` with a setup-token is the documented way to use a subscription in scripts and CI.
  - Never pass `--bare`, because bare mode ignores `CLAUDE_CODE_OAUTH_TOKEN`.
  - Never set `ANTHROPIC_API_KEY` in agent containers, because it takes priority over the OAuth token.
  - Keep auth switchable (`subscription` | `api-key`) so other people can run the tool with their own credentials.
- **The sandbox is one Docker container per agent run, with only that job's folder mounted.** Permission rules alone are not a boundary, because bash runs with the user's full rights. Containers run as non-root (required for `--dangerously-skip-permissions`) with `--cap-drop ALL`, `no-new-privileges`, CPU/memory/pids limits, and no Docker socket. The job folders reach the container as Docker Desktop drvfs mounts (`symlinkroot=/mnt/host/`). Symlinks an agent creates there turn into WSL-style links that Windows can't follow, and `fs.rmSync` deletes them fine (both tested).
- **The OAuth token is readable inside the container.** That's acceptable for the owner's own repos, and the token can only make model requests. Phase 4 adds a network egress allowlist.
- **Agents never hold Jira or Bitbucket credentials and never push.** The worker commits to a local branch. The orchestrator runs on the host as trusted code and does the push and opens the PR.
- **Roles:**
  - *Worker*: full tools, its own clone, and a branch named `ai/<KEY>-<slug>`. Every commit message starts with the issue key, so Jira links it automatically.
  - *Reviewer*: gets the ticket, the diff and the repo, but not the worker's reasoning. It works on a fresh clone of the worker's commit, has no edit tools, and runs the checks itself. For bugs it requires a reproduction test that fails on the base commit and passes on the branch. It returns its verdict through `--output-format json --json-schema`. After at most 3 review rounds, the job escalates to a human.
  - *Watchdog*: a PreToolUse hook blocks protected paths and dangerous commands. The orchestrator also reads `--output-format stream-json --verbose` and enforces turn and time limits and stuck detection.
- **Hard gate:** the project's `checks` commands must pass before any PR is opened.
- **Trigger:** poll Jira with JQL every 1–2 minutes, so a home PC needs no inbound ports.
- **Usage limits:** subscription limits are shared with the owner's interactive Claude use. On a `system/api_retry` event with `error: "rate_limit"`, pause the job, then continue later with `--resume <session_id>`. A rejected request also shows up as `{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":<unix seconds>,"errorCode":...}}`, followed by a result with `is_error: true`, `api_error_status: 429` and `api_error_code`. That result's `subtype` can still say `success`, so check `is_error`. Keep `CLAUDE_CONFIG_DIR` in the job folder so the session outlives the container.
- **Platforms:** Jira Cloud (email + API token) and Bitbucket Cloud (REST 2.0 pull requests). `BITBUCKET_TOKEN` can be either kind: an Atlassian API token with Bitbucket scopes acts as the owner's account, so PRs show the owner as author (git username `x-bitbucket-api-token-auth`); a repository access token acts as a separate bot (git username `x-token-auth`). aidev tells them apart by prefix (`ATATT` vs `ATCTT`). Both accept `Authorization: Bearer` for REST.
- **Models:** configurable per role with `--model`. Default to the strongest model the subscription allows.

## Planned layout

```
src/         orchestrator (TypeScript, run directly by Node 24): cli, pipeline, agent, docker, git, jira, config; later poller, bitbucket
images/      base.Dockerfile (Node + Claude Code CLI) + per-stack images (node, flutter)
prompts/     worker, reviewer, triage
projects/    example.yaml committed; real *.yaml gitignored
workspace/   gitignored: mirrors/ and jobs/<KEY>/{work, review-N, claude, events.jsonl}
.env         gitignored: Jira and Bitbucket tokens, CLAUDE_CODE_OAUTH_TOKEN
```

## Phases

0. Install WSL2 and Docker Desktop. Build the repo skeleton and base image, then support `aidev run <KEY>` by hand: ticket → clone → worker in a container → show the diff. Done when the agent cannot list `C:\Users` from inside the container.
1. Reviewer loop, checks gate, push, Bitbucket PR, Jira comments.
2. `aidev watch` poller, SQLite job state, watchdog hooks, pause and resume on rate limits.
3. Evals: replay already-fixed tickets from their pre-fix commit. Measure success rate, estimated cost (`total_cost_usd`) and how often the reviewer catches problems.
4. Hardening: network egress allowlist and a small local dashboard.
