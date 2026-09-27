import { spawn } from 'node:child_process';
import fs from 'node:fs';
import readline from 'node:readline';
import type { Limits, RoleConfig } from './config.ts';
import { dockerRunArgs } from './docker.ts';
import { exec } from './exec.ts';
import { dim } from './ui.ts';

export interface AgentRun {
  role: string;
  jobKey: string;
  image: string;
  /** Mounted at /work; the agent's working directory. */
  work: string;
  /** Mounted at /claude as CLAUDE_CONFIG_DIR, so the session survives the container. */
  claudeDir: string;
  eventsFile: string;
  logFile: string;
  prompt: string;
  config: RoleConfig;
  limits: Limits;
  /** The one Claude credential variable to pass in; see claudeAuthVar(). */
  authVar: string;
}

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
  /** Set when the orchestrator stopped the container. */
  stopped?: 'timeout' | 'interrupted';
}

/** The Claude Code command inside the container. Never --bare: bare mode ignores CLAUDE_CODE_OAUTH_TOKEN. */
export function claudeCommand(config: RoleConfig): string[] {
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
  return args;
}

/**
 * Runs Claude Code in a fresh container with the prompt on stdin. Every stream-json event is
 * appended to the events file, and progress is printed. Stops the container at the time limit or on Ctrl+C.
 */
export async function runAgent(run: AgentRun): Promise<AgentResult> {
  const name = `aidev-${run.jobKey.toLowerCase()}-${run.role}-${Date.now().toString(36)}`;
  const args = dockerRunArgs({
    name,
    image: run.image,
    mounts: [
      { source: run.work, target: '/work' },
      { source: run.claudeDir, target: '/claude' },
    ],
    env: [run.authVar],
    limits: run.limits,
    labels: { 'aidev.job': run.jobKey, 'aidev.role': run.role },
    command: claudeCommand(run.config),
  });

  const events = fs.createWriteStream(run.eventsFile, { flags: 'a' });
  const log = fs.createWriteStream(run.logFile, { flags: 'a' });
  const result: AgentResult = { exitCode: 1, isError: true };

  const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const stop = (reason: 'timeout' | 'interrupted') => {
    if (result.stopped) return;
    result.stopped = reason;
    exec('docker', ['kill', name], { allowFail: true }).catch(() => {});
  };
  const timer = setTimeout(() => {
    console.log(`\nThe ${run.role} reached its ${run.config.timeoutMinutes}-minute limit. Stopping it...`);
    stop('timeout');
  }, run.config.timeoutMinutes * 60_000);
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
    events.write(line + '\n');
    let event: StreamEvent;
    try {
      event = JSON.parse(line) as StreamEvent;
    } catch {
      if (line.trim()) console.log(dim(line));
      return;
    }
    if (event.type === 'system' && event.subtype === 'init') result.sessionId = event.session_id;
    if (event.type === 'result') {
      result.sessionId = event.session_id ?? result.sessionId;
      result.subtype = event.subtype;
      result.isError = Boolean(event.is_error);
      if (result.isError) result.error = event.api_error_code ?? event.terminal_reason ?? event.subtype;
      result.numTurns = event.num_turns;
      result.costUsd = event.total_cost_usd;
      result.text = typeof event.result === 'string' ? event.result : undefined;
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
    process.off('SIGINT', onInterrupt);
    await Promise.all([new Promise((r) => events.end(r)), new Promise((r) => log.end(r))]);
  }
  return result;
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
