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
  readProject,
  type JobPaths,
  type ProjectConfig,
} from './config.ts';
import { assertDocker, imageExists } from './docker.ts';
import { branchName, cloneForReview, git, prepareWorkClone, summarizeWork, syncMirror, type WorkSummary } from './git.ts';
import { interruptRequested } from './interrupt.ts';
import { fetchTicket, readTicketFile, type Ticket } from './jira.ts';
import { agentSummary, readJob, writeJob, type JobRecord, type Outcome, type RoundRecord } from './job.ts';
import { CONTINUE_PROMPT, reviewerPrompt, workerFixPrompt, workerPrompt } from './prompts.ts';
import { moveJira, notifyJira, publish } from './publish.ts';
import {
  VERDICT_SCHEMA,
  checksFeedback,
  formatIssues,
  judge,
  parseVerdict,
  protectedFeedback,
  reviewFeedback,
  type ReviewIssue,
  type Verdict,
} from './review.ts';
import { dim, fail, formatDuration, indent, ok, step, warn } from './ui.ts';
import { protectedBy } from './watchdog/policy.ts';

export interface RunOptions {
  key: string;
  /** Project name, or a path to a project .yaml file. */
  project?: string;
  /** Read the ticket from this Markdown file instead of Jira. */
  ticketFile?: string;
  /** Delete the job folder from an earlier run first. */
  fresh: boolean;
  /** Keep everything on this PC: no push, pull request or Jira update. */
  local: boolean;
}

/** Worker → checks → review rounds before the ticket goes to a person. */
export const MAX_ROUNDS = 3;
/** Exit code of a job that paused, for a usage limit or Ctrl+C. */
export const PAUSED_EXIT_CODE = 3;
/** The reviewer can read and run commands, but has no edit tools. */
const REVIEWER_TOOLS = ['Bash', 'Read', 'Grep', 'Glob'];
/** Longer diffs are only saved to diff.patch, not printed. */
const MAX_PRINTED_DIFF_LINES = 400;
/** Jira comments carry at most this much of the reviewer's or the checks' findings. */
const MAX_COMMENT_FINDINGS = 3000;
/** How long to wait when a usage limit doesn't say when it resets. */
const DEFAULT_LIMIT_WAIT_MS = 30 * 60_000;
/** Extra wait after a usage limit's reset time, so the first request isn't early. */
const LIMIT_MARGIN_MS = 60_000;

interface Run {
  project: ProjectConfig;
  ticket: Ticket;
  paths: JobPaths;
  job: JobRecord;
  authVar: string;
  save: () => void;
}

/** Starts a job: ticket → clone → rounds of worker, checks and review → pull request. Resolves to the exit code. */
export async function runTicket(opts: RunOptions): Promise<number> {
  const { key } = opts;
  assertIssueKey(key);
  const project = findProject(key, opts.project);
  const authVar = await preflight(project);
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
    local: opts.local,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    rounds: [],
    resumePoint: { round: 1, step: 'worker' },
  };
  const run: Run = { project, ticket, paths, job, authVar, save: () => writeJob(paths.meta, job) };
  run.save();
  if (!job.local) {
    await moveJira(job, project, ticket, project.jiraStatus.working);
    run.save();
  }
  return continueJob(run);
}

/** `aidev resume <KEY>`: continues a paused job, or one that a crash or restart left running. */
export async function resumeTicket(key: string): Promise<number> {
  assertIssueKey(key);
  const paths = jobPaths(key);
  if (!fs.existsSync(paths.meta)) throw new Error(`There's no job for ${key}. Start one with: aidev run ${key}`);
  const job = readJob(paths.meta);
  if (job.outcome !== 'paused' && job.outcome !== 'running') {
    throw new Error(`${key} ended as "${job.outcome ?? 'unknown'}", so there's nothing to resume. Start over with: aidev run ${key} --fresh`);
  }
  if (job.outcome === 'running' && job.pid && job.pid !== process.pid && isAlive(job.pid)) {
    throw new Error(`${key} is still running, in process ${job.pid}.`);
  }
  const project = readProject(job.projectFile);
  const authVar = await preflight(project);
  const ticket = JSON.parse(fs.readFileSync(paths.ticket, 'utf8')) as Ticket;
  const at = job.resumePoint ?? { round: 1, step: 'worker' };
  step(`Resuming ${key}: round ${at.round}, ${at.step === 'worker' ? 'the worker' : 'checks and review'}`);
  Object.assign(job, { outcome: 'running', pid: process.pid, pausedUntil: undefined, reason: undefined });
  const run: Run = { project, ticket, paths, job, authVar, save: () => writeJob(paths.meta, job) };
  run.save();
  return continueJob(run);
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function preflight(project: ProjectConfig): Promise<string> {
  assertProjectReady(project);
  const authVar = claudeAuthVar();
  await assertDocker();
  if (!(await imageExists(project.image))) {
    throw new Error(`The Docker image ${project.image} doesn't exist yet. Build it with: aidev build ${project.image.replace(/^aidev-/, '')}`);
  }
  return authVar;
}

/** Runs rounds from the job's resume point until it ends or pauses. */
async function continueJob(run: Run): Promise<number> {
  const { job } = run;
  let { round, step: from } = job.resumePoint ?? { round: 1, step: 'worker' as const };
  for (; round <= MAX_ROUNDS; round++, from = 'worker') {
    if (from === 'worker') {
      if (interruptRequested()) return pause(run, 'interrupted');
      job.resumePoint = { round, step: 'worker' };
      run.save();
      const ended = await workerStep(run, round);
      if (ended !== undefined) return ended;
    }
    if (interruptRequested()) return pause(run, 'interrupted');
    job.resumePoint = { round, step: 'verify' };
    run.save();
    const ended = await verifyStep(run, round);
    if (ended !== undefined) return ended;
  }
  return finish(run, await summarizeWork(run.paths.work, job.baseSha, job.key), 'escalated', `no approval after ${MAX_ROUNDS} rounds`);
}

/** The worker's turn in a round. Resolves to an exit code if the job ends or pauses here. */
async function workerStep(run: Run, round: number): Promise<number | undefined> {
  const { project, ticket, paths, job } = run;
  // This round's worker already started once, and a usage limit or restart cut it off.
  const cutOff = job.rounds.some((r) => r.round === round);
  const continuing = cutOff && job.session !== undefined;
  step(round === 1 && !cutOff ? `Worker: ${project.worker.model} in ${project.image}` : `Worker, round ${round} of ${MAX_ROUNDS}${cutOff ? ', continued' : ''}`);

  let prompt: string;
  if (continuing) prompt = CONTINUE_PROMPT;
  else if (round === 1) prompt = workerPrompt(ticket, project, job.branch);
  else if (job.session) prompt = workerFixPrompt(ticket, job.feedback ?? '', round, MAX_ROUNDS);
  // No session to resume, so the worker needs the ticket as well as the feedback.
  else prompt = `${workerPrompt(ticket, project, job.branch)}\n\n---\n\n${workerFixPrompt(ticket, job.feedback ?? '', round, MAX_ROUNDS)}`;
  const name = `worker-${round}${cutOff ? '-continued' : ''}`;
  fs.writeFileSync(paths.log(`${name}.prompt.md`), prompt);

  const worker = await runAgent({
    role: 'worker',
    jobKey: job.key,
    image: project.image,
    work: paths.work,
    claudeDir: paths.claude,
    eventsFile: paths.log(`${name}.jsonl`),
    logFile: paths.log(`${name}.stderr.log`),
    prompt,
    config: project.worker,
    limits: project.limits,
    authVar: run.authVar,
    resume: round > 1 || continuing ? job.session : undefined,
    protectedPaths: project.protectedPaths,
  });
  job.session = worker.sessionId ?? job.session;
  const work = await summarizeWork(paths.work, job.baseSha, job.key);
  const record: RoundRecord = { round, worker: agentSummary(worker), headSha: work.headSha, commits: work.commits };
  job.rounds = [...job.rounds.filter((r) => r.round !== round), record];
  run.save();
  console.log(`Worker: ${describeRun(worker)}`);

  if (worker.stopped === 'rate_limited' || worker.stopped === 'interrupted') return pause(run, worker.stopped, worker.rateLimitResetsAt);
  if (worker.stopped || worker.isError) return finish(run, work, 'failed', `the worker ${failureReason(worker)}`);
  if (isBlocked(worker)) return finish(run, work, 'blocked');
  if (work.commits.length === 0) return finish(run, work, 'failed', 'the worker made no commits');
  return undefined;
}

/**
 * The gates on the worker's commit: protected files, then the checks, then the review.
 * Resolves to an exit code if the job ends or pauses here; otherwise job.feedback holds what to fix.
 */
async function verifyStep(run: Run, round: number): Promise<number | undefined> {
  const { project, ticket, paths, job } = run;
  const work = await summarizeWork(paths.work, job.baseSha, job.key);
  const record = job.rounds.find((r) => r.round === round)!;

  // The watchdog hook blocks most edits to protected files; this catches any other way in.
  const touched = work.files.flatMap((file) => {
    const pattern = protectedBy(file, project.protectedPaths);
    return pattern ? [{ file, pattern }] : [];
  });
  if (touched.length) {
    step(`Protected files, round ${round}`);
    for (const t of touched) fail(`${t.file} is protected (${t.pattern})`);
    console.log('This goes back to the worker.');
    record.protectedFiles = touched.map((t) => t.file);
    job.feedback = protectedFeedback(touched) + dirtyNote(work);
    run.save();
    return undefined;
  }

  step(`Checks, round ${round}`);
  const reviewDir = paths.review(round);
  fs.rmSync(reviewDir, { recursive: true, force: true, maxRetries: 3 });
  await cloneForReview(paths.work, reviewDir, work.headSha);
  console.log(dim(`Running ${project.checks.length} check(s) on ${work.headSha.slice(0, 10)} in a fresh clone...`));
  const checks = await runChecks({
    jobKey: job.key,
    image: project.image,
    dir: reviewDir,
    checks: project.checks,
    limits: project.limits,
    logFile: paths.log(`checks-${round}.log`),
  });
  if (interruptRequested()) return pause(run, 'interrupted');
  record.checks = { passed: checks.passed, stopped: checks.stopped, results: checks.results.map(({ command, exitCode }) => ({ command, exitCode })) };
  run.save();
  printChecks(checks, project.checks);
  if (!checks.passed) {
    job.feedback = checksFeedback(checks, work.headSha) + dirtyNote(work);
    run.save();
    return undefined;
  }

  step(`Review, round ${round}: ${project.reviewer.model}`);
  const prompt = reviewerPrompt(ticket, project, { branch: job.branch, baseSha: job.baseSha, headSha: work.headSha });
  fs.writeFileSync(paths.log(`review-${round}.prompt.md`), prompt);
  const reviewer = await runAgent({
    role: 'reviewer',
    jobKey: job.key,
    image: project.image,
    work: reviewDir,
    eventsFile: paths.log(`review-${round}.jsonl`),
    logFile: paths.log(`review-${round}.stderr.log`),
    prompt,
    config: project.reviewer,
    limits: project.limits,
    authVar: run.authVar,
    tools: REVIEWER_TOOLS,
    jsonSchema: VERDICT_SCHEMA,
    protectedPaths: project.protectedPaths,
  });
  if (reviewer.stopped === 'rate_limited' || reviewer.stopped === 'interrupted') return pause(run, reviewer.stopped, reviewer.rateLimitResetsAt);
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
  job.feedback = reviewFeedback(verdict, problems) + dirtyNote(work);
  run.save();
  return undefined;
}

/** Stops here and saves where to continue. A usage limit waits until it resets; Ctrl+C can continue at once. */
function pause(run: Run, why: 'rate_limited' | 'interrupted', resetsAt?: number): number {
  const { job } = run;
  const until = why === 'interrupted' ? Date.now() : resetsAt ? resetsAt + LIMIT_MARGIN_MS : Date.now() + DEFAULT_LIMIT_WAIT_MS;
  Object.assign(job, { outcome: 'paused', pausedUntil: new Date(until).toISOString(), reason: why === 'rate_limited' ? 'a usage limit' : 'it was interrupted' });
  run.save();
  step('Paused');
  if (why === 'rate_limited') warn(`A usage limit stopped the job. It can continue after ${new Date(until).toLocaleString()}.`);
  else warn('The job was interrupted.');
  console.log(`aidev watch continues it by itself, or run: aidev resume ${job.key}`);
  return PAUSED_EXIT_CODE;
}

async function finish(run: Run, work: WorkSummary, outcome: Outcome, reason?: string): Promise<number> {
  const { project, ticket, paths, job } = run;
  Object.assign(job, { outcome, reason, finishedAt: new Date().toISOString(), resumePoint: undefined });
  fs.writeFileSync(paths.diff, work.diff);
  run.save();

  step('Result');
  await showChange(paths, job, work);
  const worker = job.rounds.at(-1)?.worker;
  let code = 1;

  if (outcome === 'approved') {
    ok(`Approved in round ${job.rounds.length} of ${MAX_ROUNDS}.`);
    if (job.local) {
      console.log(`--local: nothing left this PC. To push the branch and open the pull request: aidev publish ${job.key}`);
      code = 0;
    } else {
      try {
        await publish(job, project, ticket, paths.work);
        code = 0;
      } catch (err) {
        fail(`Publishing failed: ${(err as Error).message}`);
        console.log(`Once that's fixed, retry with: aidev publish ${job.key}`);
      }
    }
  } else if (outcome === 'blocked') {
    const question = worker?.text?.trim().replace(/^BLOCKED:\s*/, '') ?? '';
    warn('The worker is blocked and needs an answer:');
    console.log(indent(question));
    await tellJira(run, `aidev's worker stopped because it needs an answer:\n\n${question}\n\nReply in a comment, then move the ticket back to "${project.jiraStatus.pickUp ?? 'the AI queue'}" or run aidev on it again.`);
  } else if (outcome === 'escalated') {
    fail(`Escalated to a person: ${reason}.`);
    if (job.feedback) console.log(`\nThe latest findings:\n${indent(job.feedback)}`);
    await tellJira(
      run,
      `aidev couldn't get this ticket through review in ${MAX_ROUNDS} rounds, so it needs a person.\n\nThe latest findings:\n\n${truncate(job.feedback ?? '', MAX_COMMENT_FINDINGS)}\n\nThe work is on branch ${job.branch} in aidev's job folder. Nothing was pushed.`,
    );
  } else {
    fail(`Failed: ${reason}.`);
    await tellJira(run, `aidev couldn't finish this ticket: ${reason}. The details are in its job folder on the aidev PC.`);
  }
  run.save();

  console.log(dim(`\nJob folder: ${path.relative(ROOT, paths.dir)} (job.json, diff.patch, logs/, and the clone in work/)`));
  return code;
}

/** For a job that can't finish: a comment on the ticket, and the move to the project's "stuck" status. */
async function tellJira(run: Run, comment: string): Promise<void> {
  if (run.job.local) return;
  await notifyJira(run.ticket, comment);
  await moveJira(run.job, run.project, run.ticket, run.project.jiraStatus.stuck);
}

/** The worker prompt asks it to start its final message with BLOCKED: when it can't go on. */
function isBlocked(result: AgentResult): boolean {
  return result.text?.trimStart().startsWith('BLOCKED:') ?? false;
}

function failureReason(result: AgentResult): string {
  if (result.stopped === 'stuck') return `got stuck (${result.stopDetail ?? 'no progress'})`;
  if (result.stopped) return `was stopped (${result.stopped})`;
  return `failed (${result.error ?? result.subtype ?? `exit code ${result.exitCode}`})`;
}

function describeRun(result: AgentResult): string {
  const facts = [
    result.stopped
      ? `stopped (${result.stopped}${result.stopDetail ? `: ${result.stopDetail}` : ''})`
      : result.isError
        ? `failed (${result.error ?? result.subtype})`
        : isBlocked(result)
          ? 'blocked'
          : 'done',
  ];
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
  if (!approved) console.log('\nThis goes back to the worker.');
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
