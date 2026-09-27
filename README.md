# aidev

aidev watches Jira for tickets and has a Claude Code agent implement each one inside a locked-down Docker container. A second, independent agent reviews the work, the project's checks must pass, and then aidev opens a Bitbucket pull request and updates the ticket. [CLAUDE.md](CLAUDE.md) has the design and the roadmap.

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

### Hands-off: `aidev watch`

```
aidev watch
```

Leave this running in a terminal. Every 90 seconds (`--interval` changes it), it looks in Jira for tickets in each project's `jiraStatus.pickUp` status, such as "AI Tasks", and works through them one at a time, as `aidev run` below does. The ticket moves through the board as it goes:

| When | The ticket moves to (`jiraStatus`) |
|---|---|
| aidev starts on it | `working`, such as "In Progress" |
| its pull request is open | `prOpened`, such as "In Review" |
| aidev can't finish (it needs an answer, failed review 3 times, or broke) | `stuck`, such as "To Do", with a comment saying why |

To have aidev try a stuck ticket again, answer or fix the ticket, then move it back to the pick-up status.

Jobs pause instead of failing when a usage limit cuts them off. The subscription's limits are shared with your own Claude use. `aidev watch` continues a paused job once its limit resets, and starts nothing new until then. It also continues any job that a crash, a restart or Ctrl+C cut off. The first Ctrl+C stops after the current step; a second one quits at once.

### One ticket: `aidev run`

```
aidev run POT-12
```

This does the following:

1. Reads POT-12 from Jira. To use a Markdown file instead, pass `--ticket-file ticket.md`.
2. Updates a mirror of the project's repo, then clones it into `workspace/jobs/POT-12/work` on a new branch, `ai/POT-12-<summary>`.
3. Runs up to 3 rounds of:
   1. **The worker** implements the ticket in a container that sees only its clone, and commits. Every commit message must start with the issue key. From round 2, it continues its earlier session with the feedback.
   2. **The checks** from the project config run on a fresh clone of the worker's commit, in a container with no credentials at all. If one fails, its output goes back to the worker.
   3. **The reviewer**, a separate agent with no edit tools, reviews the change without seeing the worker's reasoning. It returns a structured verdict. For a bug, a test must be shown to fail without the fix and pass with it. If the reviewer asks for changes, they go back to the worker.
4. Ends in one of these outcomes:
   - **Approved:** aidev pushes the approved commit, opens a pull request and links it in a Jira comment.
   - **Blocked:** the worker needs an answer, and aidev posts its question on the ticket.
   - **Escalated:** 3 rounds went by without approval, so aidev hands the ticket to a person with the latest findings.
   - **Failed:** an error, a time limit or an agent going in circles stopped the run.
   - **Paused:** a usage limit or Ctrl+C stopped it partway. `aidev resume POT-12` continues where it stopped.

Add `--local` to do everything except push, open the pull request and update Jira. `aidev publish POT-12` then publishes an approved job. It also retries a publish that failed, for example because Bitbucket was down.

Everything is kept in `workspace/jobs/POT-12/`: the ticket, `job.json` (every round's result and verdict), `diff.patch`, the clone in `work/`, a fresh clone per round in `review-N/`, and in `logs/` every prompt, agent event stream and check output. To start a ticket over, add `--fresh`.

The project is picked by matching the issue key to `jiraProject` in `projects/*.yaml`. You can also pass `--project <name>` or `--project path/to/config.yaml`.

## The sandbox

- Each agent run gets a fresh container with only the job's folders mounted: `/work` (the clone) and, for the worker, `/claude` (its Claude session).
- The container runs as a non-root user, with all Linux capabilities dropped, `no-new-privileges`, CPU, memory and process limits, and no Docker socket.
- The only secret inside is the Claude token. Jira and Bitbucket credentials stay with the orchestrator, which does all pushing.
- The container can still reach the network, including services on your PC. Phase 4 adds an egress allowlist.

On top of the container, a watchdog checks each tool call before it runs. It's a Claude Code hook in managed settings, which the repo's own settings can't override, and it's mounted read-only from `src/watchdog/`. It blocks:

- edits to protected paths: `.git`, `.claude`, CI config, `.env` files, keystores, and any `protectedPaths` the project adds;
- `git push`, skipping commit hooks, and deleting the whole repository.

aidev also checks every round's commits for protected files, however they were changed. It stops an agent that makes the same tool call 5 times in a row, or prints nothing for 15 minutes.

`aidev sandbox-test` checks all of this in a real container. Pass `--image aidev-flutter` to check another image.

## Development

```
npm test           # unit tests
npm run typecheck  # tsc; Node runs the .ts files directly, so there's no build step
```
