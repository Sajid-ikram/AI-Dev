// What agents may not do. Used by the PreToolUse hook inside agent containers (hook.ts) and by
// the orchestrator's check of each round's diff. Keep this file free of imports from the rest
// of src/: it's mounted into containers on its own.

/** Paths no agent may change, relative to the repo root. Projects add theirs with protectedPaths. */
export const DEFAULT_PROTECTED_PATHS = [
  '.git/**',
  '.claude/**',
  '.github/**',
  'bitbucket-pipelines.yml',
  '.gitlab-ci.yml',
  '**/.env',
  '**/*.jks',
  '**/*.keystore',
  '**/key.properties',
];

/** The repo root inside agent containers. */
const WORK = '/work';

/** Supports `**` (any number of folders), `*` (within one path segment) and `?`. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      i++;
      if (glob[i + 1] === '/') {
        i++;
        re += '(?:.*/)?';
      } else {
        re += '.*';
      }
    } else if (c === '*') {
      re += '[^/]*';
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`);
}

/** The pattern that protects `relPath` (relative to the repo root, with / separators), if any. */
export function protectedBy(relPath: string, patterns: string[]): string | undefined {
  return patterns.find((p) => globToRegExp(p).test(relPath));
}

/** Why a tool call must not run, or undefined when it may. */
export function checkToolUse(toolName: string, input: Record<string, unknown>, patterns: string[]): string | undefined {
  if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(toolName)) {
    const file = String(input.file_path ?? input.notebook_path ?? '');
    const rel = file.startsWith(`${WORK}/`) ? file.slice(WORK.length + 1) : undefined;
    const pattern = rel && protectedBy(rel, patterns);
    if (pattern) {
      return `${rel} is protected (${pattern}), so agents can't change it. If the ticket needs this change, stop and start your final message with BLOCKED:.`;
    }
  }
  if (toolName === 'Bash') return checkCommand(String(input.command ?? ''), patterns);
  return undefined;
}

function checkCommand(command: string, patterns: string[]): string | undefined {
  // One shell command at a time: split on ; && || | and newlines, keeping it simple.
  const parts = command.split(/;|&&|\|\||\||\n/).map((p) => p.trim());
  for (const part of parts) {
    if (/^(\S+=\S*\s+)*git\b.*\spush\b/.test(part)) return "Agents never push. aidev pushes the branch itself once the work passes review.";
    // Only the flags count, not a quoted commit message that happens to contain "-n".
    const flags = part.split(/["']/)[0];
    if (/^(\S+=\S*\s+)*git\b.*\scommit\b.*(\s--no-verify\b|\s-[a-zA-Z]*n[a-zA-Z]*(?=\s|$))/.test(flags)) {
      return "Don't skip the commit hooks: they check that every commit message starts with the issue key.";
    }
    if (/core\.hooksPath|\.git\/hooks/.test(part)) return 'The commit hooks are managed by aidev, so leave them alone.';
    if (/^(\S+=\S*\s+)*rm\s/.test(part) && /\s-[a-zA-Z]*r/.test(part) && /\s(\/|\/\*|~\/?|\$HOME\/?|\/work\/?\*?|\.\/?\*?|\.\.\/?|\*)(\s|$)/.test(part)) {
      return 'That would delete the whole repository or more. Delete specific files or folders instead.';
    }
    const writes = /(>|\btee\b|\bsed\s+-i|\bcp\b|\bmv\b|\brm\b|\btouch\b|\bmkdir\b|\bchmod\b)/.test(part);
    const target = writes && literalPrefixes(patterns).find((prefix) => part.includes(prefix));
    if (target) {
      return `This command looks like it changes ${target}, which is protected. If you only meant to read it, use the Read tool. If the ticket needs the change, stop and start your final message with BLOCKED:.`;
    }
  }
  return undefined;
}

/** The fixed part of each pattern before any wildcard, such as ".github/" or "bitbucket-pipelines.yml". */
function literalPrefixes(patterns: string[]): string[] {
  return patterns.map((p) => p.replace(/^\*\*\//, '').split(/[*?]/)[0]).filter((p) => p.length >= 4);
}
