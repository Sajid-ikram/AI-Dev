import { spawn } from 'node:child_process';
import fs from 'node:fs';
import readline from 'node:readline';
import type { Limits, RoleConfig } from './config.ts';
import { WATCHDOG_MOUNTS, dockerRunArgs, type Mount } from './docker.ts';
import { exec } from './exec.ts';
import { dim } from './ui.ts';

export interface AgentRun {
  role: string;
  jobKey: string;
  image: string;
  /** Mounted at /work; the agent's working directory. */
  work: string;
  /**
   * Mounted at /claude as CLAUDE_CONFIG_DIR, so the session survives the container and can be
   * resumed. Without it the session lives and dies with the container.
   */
  claudeDir?: string;
  eventsFile: string;
  logFile: string;
  prompt: string;
  config: RoleConfig;
  limits: Limits;
  /** The one Claude credential variable to pass in; see claudeAuthVar(). */
  authVar: string;
  /** Continue this session instead of starting a new one. Needs the same claudeDir. */
  resume?: string;
  /** Limit the built-in tools, such as ['Bash', 'Read', 'Grep', 'Glob'] for a reviewer that can't edit. */
  tools?: string[];
  /** Makes the final answer JSON matching this schema, returned as structuredOutput. */
  jsonSchema?: object;
  /** Paths the watchdog hook stops the agent from editing (see src/watchdog/policy.ts). */
  protectedPaths: string[];
}

export type StopReason = 'timeout' | 'interrupted' | 'stuck' | 'rate_limited';

/** The same tool call this many times in a row means the agent is going in circles. */
const REPEAT_LIMIT = 5;
/** No output for this long means a hung command. Claude Code's own Bash timeout is at most 10 minutes. */
const IDLE_MINUTES = 15;

export interface AgentResult {
  exitCode: number;
  sessionId?: string;
  /** From Claude Code's result event: success, error_max_turns, error_during_execution... */
  subtype?: string;
  isError: boolean;
  /** Why an errored run stopped, such as credits_required. Its subtype can still say "success". */
  error?: string;
  numTurns?: number;
  /** Claude Code's estimate. On a subscription, it's what the run would have cost on the API. */
  costUsd?: number;
  /** The agent's final message. */
  text?: string;
  /** The final answer when the run had a jsonSchema. */
  structuredOutput?: unknown;
  /** Wall-clock time of the container run. */
  elapsedMs?: number;
  /** Set when the orchestrator stopped the container. */
  stopped?: StopReason;
  /** More about why it stopped, such as which tool call repeated. */
  stopDetail?: string;
  /** When a usage limit stopped the run: when the limit resets (ms since epoch), if Claude Code said. */
  rateLimitResetsAt?: number;
}

/** The Claude Code command inside the container. Never --bare: bare mode ignores CLAUDE_CODE_OAUTH_TOKEN. */
export function claudeCommand(
  config: RoleConfig,
  extras: { resume?: string; tools?: string[]; jsonSchema?: object } = {},
): string[] {
  const args = [
    'claude',
    '--print',
    '--output-format',
    'stream-json',
    '--verbose',
    '--dangerously-skip-permissions',
    '--model',
    config.model,
    '--max-turns',
    String(config.maxTurns),
  ];
  if (config.fallbackModel && config.fallbackModel !== config.model) args.push('--fallback-model', config.fallbackModel);
  if (config.effort) args.push('--effort', config.effort);
  if (extras.resume) args.push('--resume', extras.resume);
  if (extras.tools) args.push('--tools', extras.tools.join(','));
  if (extras.jsonSchema) args.push('--json-schema', JSON.stringify(extras.jsonSchema));
  return args;
}

/**
 * Runs Claude Code in a fresh container with the prompt on stdin, with the watchdog hook in place.
 * Every stream-json event is appended to the events file, and progress is printed. Stops the
 * container at the time limit, when the agent is stuck, or on Ctrl+C, and recognizes usage limits.
 */
export async function runAgent(run: AgentRun): Promise<AgentResult> {
  const name = `aidev-${run.jobKey.toLowerCase()}-${run.role}-${Date.now().toString(36)}`;
  const mounts: Mount[] = [{ source: run.work, target: '/work' }];
  if (run.claudeDir) mounts.push({ source: run.claudeDir, target: '/claude' });
  mounts.push(...WATCHDOG_MOUNTS);
  const args = dockerRunArgs({
    name,
    image: run.image,
    mounts,
    env: [run.authVar, 'AIDEV_PROTECTED_PATHS'],
    limits: run.limits,
    labels: { 'aidev.job': run.jobKey, 'aidev.role': run.role },
    command: claudeCommand(run.config, { resume: run.resume, tools: run.tools, jsonSchema: run.jsonSchema }),
  });

  const events = fs.createWriteStream(run.eventsFile, { flags: 'a' });
  const log = fs.createWriteStream(run.logFile, { flags: 'a' });
  const result: AgentResult = { exitCode: 1, isError: true };
  const startedAt = Date.now();
  /** A usage limit rejected a request during this run. */
  let limited = false;
  let apiErrorStatus: number | undefined;

  const child = spawn('docker', args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    env: { ...process.env, AIDEV_PROTECTED_PATHS: JSON.stringify(run.protectedPaths) },
  });
  const stop = (reason: StopReason, detail?: string) => {
    if (result.stopped) return;
    result.stopped = reason;
    result.stopDetail = detail;
    exec('docker', ['kill', name], { allowFail: true }).catch(() => {});
  };
  const timer = setTimeout(() => {
    console.log(`\nThe ${run.role} reached its ${run.config.timeoutMinutes}-minute limit. Stopping it...`);
    stop('timeout');
  }, run.config.timeoutMinutes * 60_000);
  let idleTimer: NodeJS.Timeout | undefined;
  const resetIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      console.log(`\nThe ${run.role} printed nothing for ${IDLE_MINUTES} minutes. Stopping it...`);
      // Silence after a usage limit rejected a request is Claude Code waiting for the limit.
      if (limited) stop('rate_limited');
      else stop('stuck', `no output for ${IDLE_MINUTES} minutes`);
    }, IDLE_MINUTES * 60_000);
  };
  resetIdle();
  const loops = new LoopDetector(REPEAT_LIMIT);
  const onInterrupt = () => {
    console.log(`\nStopping the ${run.role}...`);
    stop('interrupted');
  };
  process.on('SIGINT', onInterrupt);

  // The container can exit before reading its prompt; that shows up in the result, not as a crash here.
  child.stdin.on('error', () => {});
  child.stdin.end(run.prompt);
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    log.write(chunk);
    process.stderr.write(dim(chunk));
  });
  readline.createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', (line) => {
    resetIdle();
    events.write(line + '\n');
    let event: StreamEvent;
    try {
      event = JSON.parse(line) as StreamEvent;
    } catch {
      if (line.trim()) console.log(dim(line));
      return;
    }
    if (event.type === 'system' && event.subtype === 'init') result.sessionId = event.session_id;
    // Not stopped right away: Claude Code may carry on with the fallback model.
    const limit = usageLimit(event);
    if (limit) {
      limited = true;
      result.rateLimitResetsAt = limit.resetsAt ?? result.rateLimitResetsAt;
    }
    if (event.type === 'assistant' && !event.parent_tool_use_id) {
      for (const block of event.message?.content ?? []) {
        if (block.type === 'tool_use' && loops.see(block.name, block.input)) {
          stop('stuck', `it ran the same ${block.name} call ${REPEAT_LIMIT} times in a row`);
        }
      }
    }
    if (event.type === 'result') {
      result.sessionId = event.session_id ?? result.sessionId;
      result.subtype = event.subtype;
      result.isError = Boolean(event.is_error);
      if (result.isError) result.error = event.api_error_code ?? event.terminal_reason ?? event.subtype;
      apiErrorStatus = event.api_error_status;
      result.numTurns = event.num_turns;
      result.costUsd = event.total_cost_usd;
      result.text = typeof event.result === 'string' ? event.result : undefined;
      result.structuredOutput = event.structured_output;
    }
    const text = describeEvent(event);
    if (text) console.log(text);
  });

  try {
    result.exitCode = await new Promise<number>((resolve, reject) => {
      child.on('error', (err) => reject(new Error(`Could not start docker: ${err.message}`)));
      child.on('close', (code) => resolve(code ?? 1));
    });
  } finally {
    clearTimeout(timer);
    clearTimeout(idleTimer);
    process.off('SIGINT', onInterrupt);
    await Promise.all([new Promise((r) => events.end(r)), new Promise((r) => log.end(r))]);
  }
  // A run that failed after a usage limit rejected it, or that ended on a 429, waits for the limit.
  const failed = result.isError || !result.subtype;
  const hit429 = apiErrorStatus === 429 && result.error !== 'credits_required';
  if (!result.stopped && failed && (limited || hit429)) result.stopped = 'rate_limited';
  result.elapsedMs = Date.now() - startedAt;
  return result;
}

/**
 * A usage limit that rejected a request, from a rate_limit_event. Paid-only models
 * (credits_required) don't count: waiting won't help, so that run just fails.
 */
export function usageLimit(event: StreamEvent): { resetsAt?: number } | undefined {
  const info = event.type === 'rate_limit_event' ? event.rate_limit_info : undefined;
  if (info?.status !== 'rejected' || info.errorCode === 'credits_required') return undefined;
  return { resetsAt: typeof info.resetsAt === 'number' ? info.resetsAt * 1000 : undefined };
}

/** Spots an agent going in circles: the same tool call with the same input, again and again. */
export class LoopDetector {
  private last = '';
  private count = 0;
  private readonly limit: number;

  constructor(limit: number) {
    this.limit = limit;
  }

  /** Records a tool call. True once the same call has come `limit` times in a row. */
  see(toolName: string, input: unknown): boolean {
    if (toolName === 'TodoWrite') return false;
    const signature = `${toolName} ${JSON.stringify(input)}`;
    this.count = signature === this.last ? this.count + 1 : 1;
    this.last = signature;
    return this.count >= this.limit;
  }
}

type StreamEvent = { type?: string; subtype?: string; [key: string]: any };

/** One or more progress lines for a stream-json event, or undefined for events not worth showing. */
export function describeEvent(event: StreamEvent): string | undefined {
  if (event.type === 'system' && event.subtype === 'init') return dim(`session ${event.session_id}, model ${event.model}`);
  if (event.type === 'system' && event.subtype === 'api_retry') {
    return `API retry${event.attempt ? ` ${event.attempt}` : ''}: ${event.error ?? event.error_status ?? 'error'}`;
  }
  if (event.type === 'rate_limit_event' && event.rate_limit_info?.status === 'rejected') {
    const info = event.rate_limit_info;
    const resets = info.resetsAt ? `, resets ${new Date(info.resetsAt * 1000).toLocaleString()}` : '';
    return `Usage limit: rejected (${info.errorCode ?? 'rate limit'}${resets})`;
  }
  // Messages from subagents carry parent_tool_use_id; the main agent's are enough to follow along.
  if (event.type !== 'assistant' || event.parent_tool_use_id) return undefined;
  const lines: string[] = [];
  for (const block of event.message?.content ?? []) {
    if (block.type === 'text' && block.text?.trim()) lines.push(oneLine(block.text, 240));
    else if (block.type === 'tool_use') lines.push(dim(`  > ${block.name} ${oneLine(toolSummary(block.name, block.input ?? {}), 160)}`));
  }
  return lines.length ? lines.join('\n') : undefined;
}

function toolSummary(name: string, input: Record<string, any>): string {
  const file = (p: unknown) => (typeof p === 'string' ? p.replace(/^\/work\//, '') : '');
  switch (name) {
    case 'Bash':
      return String(input.command ?? '');
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
      return file(input.file_path);
    case 'NotebookEdit':
      return file(input.notebook_path);
    case 'Grep':
    case 'Glob':
      return String(input.pattern ?? '');
    case 'WebFetch':
      return String(input.url ?? '');
    case 'WebSearch':
      return String(input.query ?? '');
    case 'Task':
    case 'Agent':
      return String(input.description ?? '');
    case 'TodoWrite':
      return '';
    default:
      return JSON.stringify(input);
  }
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
