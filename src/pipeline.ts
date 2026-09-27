import fs from 'node:fs';
import path from 'node:path';
import { runAgent, type AgentResult } from './agent.ts';
import { runChecks, type ChecksOutcome } from './checks.ts';
import {
  ROOT,
  assertIssueKey,
  assertProjectReady,
  claudeAuthVar,
  findProject,
  jobPaths,
  type JobPaths,
  type ProjectConfig,
} from './config.ts';
import { assertDocker, imageExists } from './docker.ts';
import { branchName, cloneForReview, git, prepareWorkClone, summarizeWork, syncMirror, type WorkSummary } from './git.ts';
import { fetchTicket, readTicketFile, type Ticket } from './jira.ts';
import { agentSummary, writeJob, type JobRecord, type Outcome, type RoundRecord } from './job.ts';
import { reviewerPrompt, workerFixPrompt, workerPrompt } from './prompts.ts';
import { notifyJira, publish } from './publish.ts';
import { VERDICT_SCHEMA, checksFeedback, formatIssues, judge, parseVerdict, reviewFeedback, type ReviewIssue, type Verdict } from './review.ts';
import { dim, fail, formatDuration, indent, ok, step, warn } from './ui.ts';

export interface RunOptions {
  key: string;
  /** Project name, or a path to a project .yaml file. */
  project?: string;
  /** Read the ticket from this Markdown file instead of Jira. */
  ticketFile?: string;
  /** Delete the job folder from an earlier run first. */
  fresh: boolean;
  /** Keep everything on this PC: no push, pull request or Jira comment. */
  local: boolean;
}

/** Worker → checks → review rounds before the ticket goes to a person. */
export const MAX_ROUNDS = 3;
/** The reviewer can read and run commands, but has no edit tools. */
const REVIEWER_TOOLS = ['Bash', 'Read', 'Grep', 'Glob'];
/** Longer diffs are only saved to diff.patch, not printed. */
const MAX_PRINTED_DIFF_LINES = 400;
/** Jira comments carry at most this much of the reviewer's or the checks' findings. */
const MAX_COMMENT_FINDINGS = 3000;

interface Run {
  opts: RunOptions;
  project: ProjectConfig;
  ticket: Ticket;
  paths: JobPaths;
  job: JobRecord;
  save: () => void;
}

/**
 * ticket → clone → up to MAX_ROUNDS of worker, checks and review → push and pull request.
 * Resolves to the process exit code: 0 when the work was approved.
 */
export async function runTicket(opts: RunOptions): Promise<number> {
  const { key } = opts;
  assertIssueKey(key);
  const project = findProject(key, opts.project);
  assertProjectReady(project);
  const authVar = claudeAuthVar();
  await assertDocker();
  if (!(await imageExists(project.image))) {
    throw new Error(`The Docker image ${project.image} doesn't exist yet. Build it with: aidev build ${project.image.replace(/^aidev-/, '')}`);
  }
  const paths = jobPaths(key);
  if (fs.existsSync(paths.dir) && !opts.fresh) {
    throw new Error(`${path.relative(ROOT, paths.dir)} exists from an earlier run. Pass --fresh to delete it and start over.`);
  }

  step('Ticket');
  const ticket = opts.ticketFile ? readTicketFile(opts.ticketFile, key) : await fetchTicket(key);
  console.log(`${ticket.key} (${ticket.type}): ${ticket.summary}`);

  fs.rmSync(paths.dir, { recursive: true, force: true, maxRetries: 3 });
  fs.mkdirSync(paths.claude, { recursive: true });
  fs.mkdirSync(paths.logs, { recursive: true });
  fs.writeFileSync(paths.ticket, `${JSON.stringify(ticket, null, 2)}\n`);

  step(`Repository: ${project.name}`);
  const mirror = await syncMirror(project);
  const branch = branchName(key, ticket.summary);
  const baseSha = await prepareWorkClone({ mirror, work: paths.work, project, branch, key });
  console.log(`Branch ${branch}, from ${project.repo.baseBranch} at ${baseSha.slice(0, 10)}`);

  const job: JobRecord = {
    key,
    project: project.name,
    projectFile: project.file,
    branch,
    baseBranch: project.repo.baseBranch,
    baseSha,
    outcome: 'running',
    startedAt: new Date().toISOString(),
    rounds: [],
  };
  const run: Run = { opts, project, ticket, paths, job, save: () => writeJob(paths.meta, job) };
  run.save();

  let feedback = '';
  let session: string | undefined;
  for (let round = 1; round <= MAX_ROUNDS; round++) {
    // The worker: the ticket in round 1, then the feedback, in the same resumed session.
    step(round === 1 ? `Worker: ${project.worker.model} in ${project.image}` : `Worker, round ${round} of ${MAX_ROUNDS}`);
    const prompt = round === 1 ? workerPrompt(ticket, project, branch) : workerFixPrompt(ticket, feedback, round, MAX_ROUNDS);
    fs.writeFileSync(paths.log(`worker-${round}.prompt.md`), prompt);
    const worker = await runAgent({
      role: 'worker',
      jobKey: key,
      image: project.image,
      work: paths.work,
      claudeDir: paths.claude,
      eventsFile: paths.log(`worker-${round}.jsonl`),
      logFile: paths.log(`worker-${round}.stderr.log`),
      prompt,
      config: project.worker,
      limits: project.limits,
      authVar,
      resume: round > 1 ? session : undefined,
    });
    session = worker.sessionId ?? session;
    const work = await summarizeWork(paths.work, baseSha, key);
    const record: RoundRecord = { round, worker: agentSummary(worker), headSha: work.headSha, commits: work.commits };
    job.rounds.push(record);
    run.save();
    console.log(`Worker: ${describeRun(worker)}`);

    if (worker.stopped || worker.isError) return finish(run, work, 'failed', `the worker ${failureReason(worker)}`);
    if (isBlocked(worker)) return finish(run, work, 'blocked');
    if (work.commits.length === 0) return finish(run, work, 'failed', 'the worker made no commits');

    // The gate: the project's checks on a fresh clone of the worker's commit.
    step(`Checks, round ${round}`);
    const reviewDir = paths.review(round);
    await cloneForReview(paths.work, reviewDir, work.headSha);
    console.log(dim(`Running ${project.checks.length} check(s) on ${work.headSha.slice(0, 10)} in a fresh clone...`));
    const checks = await runChecks({
      jobKey: key,
      image: project.image,
      dir: reviewDir,
      checks: project.checks,
      limits: project.limits,
      logFile: paths.log(`checks-${round}.log`),
    });
    record.checks = { passed: checks.passed, stopped: checks.stopped, results: checks.results.map(({ command, exitCode }) => ({ command, exitCode })) };
    run.save();
    printChecks(checks, project.checks);
    if (!checks.passed) {
      feedback = checksFeedback(checks, work.headSha) + dirtyNote(work);
      continue;
    }

    // The reviewer: same commit and folder, its own session, no edit tools, structured verdict.
    step(`Review, round ${round}: ${project.reviewer.model}`);
    const reviewPrompt = reviewerPrompt(ticket, project, { branch, baseSha, headSha: work.headSha });
    fs.writeFileSync(paths.log(`review-${round}.prompt.md`), reviewPrompt);
    const reviewer = await runAgent({
      role: 'reviewer',
      jobKey: key,
      image: project.image,
      work: reviewDir,
      eventsFile: paths.log(`review-${round}.jsonl`),
      logFile: paths.log(`review-${round}.stderr.log`),
      prompt: reviewPrompt,
      config: project.reviewer,
      limits: project.limits,
      authVar,
      tools: REVIEWER_TOOLS,
      jsonSchema: VERDICT_SCHEMA,
    });
    const verdict = parseVerdict(reviewer.structuredOutput);
    if (!verdict) {
      record.review = { agent: agentSummary(reviewer), approved: false, problems: [] };
      run.save();
      return finish(run, work, 'failed', `the reviewer gave no verdict: it ${failureReason(reviewer)}`);
    }
    const { approved, problems } = judge(verdict, ticket);
    record.review = { agent: agentSummary(reviewer), verdict, approved, problems };
    run.save();
    printVerdict(reviewer, verdict, approved, problems);
    if (approved) {
      job.approvedSha = work.headSha;
      return finish(run, work, 'approved');
    }
    feedback = reviewFeedback(verdict, problems) + dirtyNote(work);
  }

  return finish(run, await summarizeWork(paths.work, baseSha, key), 'escalated', `no approval after ${MAX_ROUNDS} rounds`, feedback);
}

async function finish(run: Run, work: WorkSummary, outcome: Outcome, reason?: string, findings?: string): Promise<number> {
  const { opts, project, ticket, paths, job } = run;
  job.outcome = outcome;
  job.reason = reason;
  job.finishedAt = new Date().toISOString();
  fs.writeFileSync(paths.diff, work.diff);
  run.save();

  step('Result');
  await showChange(paths, job, work);
  const local = opts.local || !ticket.url;
  const worker = job.rounds.at(-1)?.worker;
  let code = 1;

  if (outcome === 'approved') {
    ok(`Approved in round ${job.rounds.length} of ${MAX_ROUNDS}.`);
    if (opts.local) {
      console.log(`--local: nothing left this PC. To push the branch and open the pull request: aidev publish ${job.key}`);
      code = 0;
    } else {
      try {
        await publish(job, project, ticket, paths.work);
        code = 0;
      } catch (err) {
        fail(`Publishing failed: ${(err as Error).message}`);
        console.log(`Once that's fixed, retry with: aidev publish ${job.key}`);
      } finally {
        run.save();
      }
    }
  } else if (outcome === 'blocked') {
    const question = worker?.text?.trim().replace(/^BLOCKED:\s*/, '') ?? '';
    warn('The worker is blocked and needs an answer:');
    console.log(indent(question));
    if (!local) {
      await notifyJira(ticket, `aidev's worker stopped because it needs an answer:\n\n${question}\n\nReply in a comment, then run aidev on this ticket again.`);
    }
  } else if (outcome === 'escalated') {
    fail(`Escalated to a person: ${reason}.`);
    if (findings) console.log(`\nThe latest findings:\n${indent(findings)}`);
    if (!local) {
      await notifyJira(
        ticket,
        `aidev couldn't get this ticket through review in ${MAX_ROUNDS} rounds, so it needs a person.\n\nThe latest findings:\n\n${truncate(findings ?? '', MAX_COMMENT_FINDINGS)}\n\nThe work is on branch ${job.branch} in aidev's job folder. Nothing was pushed.`,
      );
    }
  } else {
    fail(`Failed: ${reason}.`);
    if (!local) await notifyJira(ticket, `aidev couldn't finish this ticket: ${reason}. The details are in its job folder on the aidev PC.`);
  }

  console.log(dim(`\nJob folder: ${path.relative(ROOT, paths.dir)} (job.json, diff.patch, logs/, and the clone in work/)`));
  return code;
}

/** The worker prompt asks it to start its final message with BLOCKED: when it can't go on. */
function isBlocked(result: AgentResult): boolean {
  return result.text?.trimStart().startsWith('BLOCKED:') ?? false;
}

function failureReason(result: AgentResult): string {
  if (result.stopped) return `was stopped (${result.stopped})`;
  return `failed (${result.error ?? result.subtype ?? `exit code ${result.exitCode}`})`;
}

function describeRun(result: AgentResult): string {
  const facts = [result.stopped ? `stopped (${result.stopped})` : result.isError ? `failed (${result.error ?? result.subtype})` : isBlocked(result) ? 'blocked' : 'done'];
  if (result.numTurns !== undefined) facts.push(`${result.numTurns} turns`);
  if (result.elapsedMs !== undefined) facts.push(formatDuration(result.elapsedMs));
  if (result.costUsd !== undefined) facts.push(`est. $${result.costUsd.toFixed(2)}`);
  return facts.join(', ');
}

function dirtyNote(work: WorkSummary): string {
  return work.status
    ? `\n\nAlso, you left uncommitted changes, and they weren't checked or reviewed. Commit them or remove them:\n${work.status}`
    : '';
}

function printChecks(outcome: ChecksOutcome, checks: string[]): void {
  checks.forEach((command, i) => {
    const r = outcome.results[i];
    if (!r) console.log(dim(`- ${command} (skipped)`));
    else if (r.exitCode === 0) ok(command);
    else fail(`${command} ${r.exitCode === null ? "didn't finish" : `exited with code ${r.exitCode}`}`);
  });
  const failed = outcome.results.find((r) => r.exitCode !== 0);
  if (failed?.output.trim()) console.log(dim(indent(failed.output.split('\n').slice(-20).join('\n'))));
  if (outcome.stopped) fail('The checks hit their time limit.');
  console.log(outcome.passed ? 'All checks passed.' : 'The checks failed, so this goes back to the worker.');
}

function printVerdict(reviewer: AgentResult, verdict: Verdict, approved: boolean, problems: ReviewIssue[]): void {
  console.log(`Reviewer: ${describeRun(reviewer)}`);
  console.log(`\n${verdict.verdict === 'approve' ? 'Approves' : 'Requests changes'}: ${verdict.summary}`);
  const repro = verdict.reproduction;
  if (repro) console.log(dim(`Reproduction: ${repro.test}. Fails on base: ${repro.failsOnBase}. Passes on branch: ${repro.passesOnBranch}.`));
  if (problems.length) console.log(`\n${formatIssues(problems)}`);
  const minor = verdict.issues.filter((i) => i.severity === 'minor' && !problems.includes(i));
  if (minor.length) console.log(dim(`\nMinor:\n${formatIssues(minor)}`));
  console.log(approved ? '' : '\nThis goes back to the worker.');
}

async function showChange(paths: JobPaths, job: JobRecord, work: WorkSummary): Promise<void> {
  if (work.commits.length) {
    console.log(`Commits on ${job.branch}:`);
    console.log(indent(work.commits.join('\n')));
  }
  if (work.badMessages.length) warn(`These commit messages don't start with ${job.key}:\n${indent(work.badMessages.join('\n'))}`);
  if (work.status) warn(`The worker left uncommitted changes:\n${indent(work.status)}`);
  if (!work.diff) return;
  console.log('');
  await git(['--no-pager', 'diff', '--stat', job.baseSha, 'HEAD'], { cwd: paths.work, inherit: true });
  const lines = work.diff.split('\n').length;
  if (lines <= MAX_PRINTED_DIFF_LINES) {
    console.log('');
    await git(['--no-pager', 'diff', job.baseSha, 'HEAD'], { cwd: paths.work, inherit: true });
  } else {
    console.log(dim(`\nThe diff is ${lines} lines long, so it's only saved to diff.patch.`));
  }
  console.log('');
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n[...]` : text;
}
