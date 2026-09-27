# aidev

aidev takes a Jira ticket and has a Claude Code agent implement it inside a locked-down Docker container, then shows you the diff. Later phases add an independent reviewer, the Bitbucket pull request and a Jira poller. [CLAUDE.md](CLAUDE.md) has the design and the roadmap.

## Requirements

- Docker. On Windows, that's Docker Desktop with WSL2.
- Node 24 or later, and Git.
- A Claude subscription or an API key, plus Jira Cloud and Bitbucket Cloud.

## Setup

1. Run `npm install`, then `npm link` to get the `aidev` command.
2. Run `aidev build` to build the agent images: base, node and flutter. The flutter image is about 2.5 GB.
3. Copy `.env.example` to `.env` and fill it in. On a subscription, create the token with `claude setup-token`.
4. For each project, copy `projects/example.yaml` to `projects/<name>.yaml` and fill it in.
5. Run `aidev sandbox-test --agent` to check that agent containers can't reach your files, even when Claude tries.

## Usage

```
aidev run POT-12
```

This does the following:

1. Reads POT-12 from Jira. To use a Markdown file instead, pass `--ticket-file ticket.md`.
2. Updates a mirror of the project's repo, then clones it into `workspace/jobs/POT-12/work` on a new branch, `ai/POT-12-<summary>`.
3. Starts the worker agent in a container that sees only that folder. The worker commits its work, and every commit message must start with the issue key.
4. Prints the commits, the diff and the worker's summary.

Everything is kept in `workspace/jobs/POT-12/`: the ticket, the prompt, every agent event (`events.jsonl`), `diff.patch`, `job.json` and the clone. To start a ticket over, add `--fresh`.

The project is picked by matching the issue key to `jiraProject` in `projects/*.yaml`. You can also pass `--project <name>` or `--project path/to/config.yaml`.

## The sandbox

- Each agent run gets a fresh container with only the job's folders mounted: `/work` (the clone) and `/claude` (the Claude session).
- The container runs as a non-root user, with all Linux capabilities dropped, `no-new-privileges`, CPU, memory and process limits, and no Docker socket.
- The only secret inside is the Claude token. Jira and Bitbucket credentials stay with the orchestrator, which does all pushing.
- The container can still reach the network, including services on your PC. Phase 4 adds an egress allowlist.

`aidev sandbox-test` checks all of this in a real container. Pass `--image aidev-flutter` to check another image.

## Development

```
npm test           # unit tests
npm run typecheck  # tsc; Node runs the .ts files directly, so there's no build step
```
