import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

export const ROOT = path.resolve(import.meta.dirname, '..');
export const WORKSPACE = path.join(ROOT, 'workspace');
export const PROJECTS_DIR = path.join(ROOT, 'projects');
export const PROMPTS_DIR = path.join(ROOT, 'prompts');
export const IMAGES_DIR = path.join(ROOT, 'images');

// ---------- .env ----------

export function loadEnv(): void {
  const file = path.join(ROOT, '.env');
  if (fs.existsSync(file)) process.loadEnvFile(file);
}

export function env(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

export function requireEnv(name: string, purpose: string): string {
  const value = env(name);
  if (!value) throw new Error(`${name} is not set. Add it to .env (see .env.example); it's needed ${purpose}.`);
  return value;
}

/**
 * The single Claude credential variable passed into agent containers. Never both:
 * ANTHROPIC_API_KEY takes priority over CLAUDE_CODE_OAUTH_TOKEN inside Claude Code.
 */
export function claudeAuthVar(): string {
  const mode = env('CLAUDE_AUTH') ?? 'subscription';
  if (mode === 'subscription') {
    requireEnv('CLAUDE_CODE_OAUTH_TOKEN', 'for agents to use your Claude subscription (create one with `claude setup-token`)');
    return 'CLAUDE_CODE_OAUTH_TOKEN';
  }
  if (mode === 'api-key') {
    requireEnv('ANTHROPIC_API_KEY', 'for agents to use the Claude API');
    return 'ANTHROPIC_API_KEY';
  }
  throw new Error(`CLAUDE_AUTH must be "subscription" or "api-key", not "${mode}".`);
}

export function gitIdentity(): { name: string; email: string } {
  return { name: env('AIDEV_GIT_NAME') ?? 'aidev', email: env('AIDEV_GIT_EMAIL') ?? 'aidev@localhost' };
}

// ---------- project configs ----------

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

export interface RoleConfig {
  /** A Claude Code model alias (fable, opus, sonnet) or a full model name. */
  model: string;
  /** Used when `model` is overloaded or not available on the plan. */
  fallbackModel?: string;
  effort?: (typeof EFFORTS)[number];
  maxTurns: number;
  timeoutMinutes: number;
}

export interface Limits {
  cpus: number;
  /** Docker memory limit, like "8g". */
  memory: string;
  pids: number;
}

export interface ProjectConfig {
  name: string;
  file: string;
  /** Jira project key; issues like POT-12 go to the project with jiraProject: POT. */
  jiraProject?: string;
  repo: {
    url: string;
    baseBranch: string;
    /** bitbucket: authenticate with BITBUCKET_TOKEN. none: public or local repository. */
    auth: 'bitbucket' | 'none';
  };
  /** Docker image the agents run in, such as aidev-flutter. */
  image: string;
  /** Shell commands run from the repo root. All must pass before a pull request is opened. */
  checks: string[];
  /**
   * People added as reviewers on every pull request: Atlassian account IDs, which Jira and
   * Bitbucket share. Bitbucket won't take the pull request's own author.
   */
  prReviewers: string[];
  /** Jira statuses aidev moves tickets to. Each is optional; without one, the ticket stays put. */
  jiraStatus: {
    /** Where a ticket goes once its pull request is open, such as "In Review". */
    prOpened?: string;
  };
  worker: RoleConfig;
  reviewer: RoleConfig;
  limits: Limits;
}

// The strongest model a subscription includes: Fable needs paid usage credits (API error credits_required).
export const DEFAULT_ROLE: RoleConfig = { model: 'opus', fallbackModel: 'sonnet', maxTurns: 200, timeoutMinutes: 90 };
export const DEFAULT_REVIEWER: RoleConfig = { ...DEFAULT_ROLE, maxTurns: 100, timeoutMinutes: 45 };
export const DEFAULT_LIMITS: Limits = { cpus: 4, memory: '8g', pids: 2048 };

type Obj = Record<string, unknown>;

function asObj(value: unknown, label: string): Obj {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be a mapping`);
  return value as Obj;
}

function asStr(value: unknown, label: string, fallback?: string): string {
  if (value === undefined || value === null || value === '') {
    if (fallback !== undefined) return fallback;
    throw new Error(`${label} is required`);
  }
  if (typeof value !== 'string') throw new Error(`${label} must be a string`);
  return value;
}

function asOptStr(value: unknown, label: string): string | undefined {
  return value === undefined || value === null || value === '' ? undefined : asStr(value, label);
}

function asNum(value: unknown, label: string, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !(value > 0)) throw new Error(`${label} must be a positive number`);
  return value;
}

function asOneOf<T extends string>(value: unknown, label: string, allowed: readonly T[]): T | undefined {
  if (value === undefined || value === null) return undefined;
  if (!allowed.includes(value as T)) throw new Error(`${label} must be one of: ${allowed.join(', ')}`);
  return value as T;
}

function asStrList(value: unknown, label: string): string[] {
  if (value === undefined || value === null) return [];
  // YAML reads an unquoted `false` or `42` as a boolean or number, but as a command it's text.
  const scalar = (v: unknown) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
  if (!Array.isArray(value) || !value.every(scalar)) throw new Error(`${label} must be a list of commands`);
  return value.map(String);
}

function parseRole(value: unknown, label: string, defaults: RoleConfig): RoleConfig {
  const raw = asObj(value, label);
  return {
    model: asStr(raw.model, `${label}.model`, defaults.model),
    // An explicit empty fallbackModel turns the fallback off.
    fallbackModel: raw.fallbackModel === '' ? undefined : asStr(raw.fallbackModel, `${label}.fallbackModel`, defaults.fallbackModel),
    effort: asOneOf(raw.effort, `${label}.effort`, EFFORTS),
    maxTurns: asNum(raw.maxTurns, `${label}.maxTurns`, defaults.maxTurns),
    timeoutMinutes: asNum(raw.timeoutMinutes, `${label}.timeoutMinutes`, defaults.timeoutMinutes),
  };
}

export function parseProject(file: string, data: unknown): ProjectConfig {
  try {
    const raw = asObj(data, 'the file');
    const repo = asObj(raw.repo, 'repo');
    const limits = asObj(raw.limits, 'limits');
    const jiraProject = asOptStr(raw.jiraProject, 'jiraProject');
    if (jiraProject && !/^[A-Z][A-Z0-9_]+$/.test(jiraProject)) throw new Error('jiraProject must be a Jira project key like POT');
    const memory = asStr(limits.memory, 'limits.memory', DEFAULT_LIMITS.memory);
    if (!/^\d+[bkmg]?$/i.test(memory)) throw new Error('limits.memory must look like 8g or 4096m');
    return {
      name: asStr(raw.name, 'name'),
      file,
      jiraProject,
      repo: {
        url: asStr(repo.url, 'repo.url'),
        baseBranch: asStr(repo.baseBranch, 'repo.baseBranch', 'main'),
        auth: asOneOf(repo.auth, 'repo.auth', ['bitbucket', 'none'] as const) ?? 'bitbucket',
      },
      image: asStr(raw.image, 'image'),
      checks: asStrList(raw.checks, 'checks'),
      prReviewers: asStrList(raw.prReviewers, 'prReviewers'),
      jiraStatus: { prOpened: asOptStr(asObj(raw.jiraStatus, 'jiraStatus').prOpened, 'jiraStatus.prOpened') },
      worker: parseRole(raw.worker, 'worker', DEFAULT_ROLE),
      reviewer: parseRole(raw.reviewer, 'reviewer', DEFAULT_REVIEWER),
      limits: {
        cpus: asNum(limits.cpus, 'limits.cpus', DEFAULT_LIMITS.cpus),
        memory,
        pids: asNum(limits.pids, 'limits.pids', DEFAULT_LIMITS.pids),
      },
    };
  } catch (err) {
    throw new Error(`Invalid project config ${file}: ${(err as Error).message}`);
  }
}

export function readProject(file: string): ProjectConfig {
  return parseProject(file, YAML.parse(fs.readFileSync(file, 'utf8')));
}

/**
 * Finds the project for an issue. `selector` is a project name or a path to a .yaml file;
 * without it, the issue key's prefix is matched against each project's jiraProject.
 */
export function findProject(issueKey: string, selector?: string): ProjectConfig {
  if (selector && /\.ya?ml$/i.test(selector)) return readProject(path.resolve(selector));

  const files = fs.existsSync(PROJECTS_DIR)
    ? fs.readdirSync(PROJECTS_DIR).filter((f) => /\.ya?ml$/i.test(f) && f !== 'example.yaml')
    : [];
  if (files.length === 0) {
    throw new Error('There are no project configs. Copy projects/example.yaml to projects/<name>.yaml and fill it in.');
  }
  const projects = files.map((f) => readProject(path.join(PROJECTS_DIR, f)));

  if (selector) {
    const match = projects.find((p) => p.name === selector);
    if (!match) throw new Error(`No project named "${selector}". Known projects: ${projects.map((p) => p.name).join(', ')}.`);
    return match;
  }
  const prefix = issueKey.split('-')[0];
  const matches = projects.filter((p) => p.jiraProject === prefix);
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw new Error(`Several projects use Jira project ${prefix} (${matches.map((p) => p.name).join(', ')}). Pick one with --project.`);
  }
  throw new Error(`No project config has "jiraProject: ${prefix}". Set it in projects/<name>.yaml or pass --project.`);
}

/** Catches configs that were copied from the example but not filled in. */
export function assertProjectReady(project: ProjectConfig): void {
  if (/[<>]/.test(project.repo.url)) {
    throw new Error(`repo.url in ${project.file} still has a placeholder: ${project.repo.url}`);
  }
}

export function assertIssueKey(key: string): void {
  if (!/^[A-Z][A-Z0-9_]+-\d+$/.test(key)) throw new Error(`"${key}" doesn't look like a Jira issue key, such as POT-12.`);
}

// ---------- job folders ----------

export function jobPaths(key: string) {
  const dir = path.join(WORKSPACE, 'jobs', key);
  const logs = path.join(dir, 'logs');
  return {
    dir,
    /** The worker's clone, kept across review rounds. */
    work: path.join(dir, 'work'),
    /** The worker's CLAUDE_CONFIG_DIR, so later rounds can --resume its session. */
    claude: path.join(dir, 'claude'),
    ticket: path.join(dir, 'ticket.json'),
    meta: path.join(dir, 'job.json'),
    diff: path.join(dir, 'diff.patch'),
    logs,
    /** Per-round files such as worker-1.jsonl, checks-1.log and review-1.prompt.md. */
    log: (name: string) => path.join(logs, name),
    /** A fresh clone of the worker's commit, where round N's checks and review run. */
    review: (round: number) => path.join(dir, `review-${round}`),
  };
}

export type JobPaths = ReturnType<typeof jobPaths>;
