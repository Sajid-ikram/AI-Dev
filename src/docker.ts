import path from 'node:path';
import { IMAGES_DIR, WATCHDOG_DIR, type Limits } from './config.ts';
import { exec } from './exec.ts';

export const STACKS = ['base', 'node', 'flutter'] as const;

export function imageName(stack: string): string {
  return `aidev-${stack}`;
}

export async function assertDocker(): Promise<void> {
  const res = await exec('docker', ['version', '--format', '{{.Server.Version}}'], { allowFail: true }).catch(() => undefined);
  if (!res || res.code !== 0) throw new Error("Docker isn't running. Start Docker Desktop and try again.");
}

export async function imageExists(image: string): Promise<boolean> {
  return (await exec('docker', ['image', 'inspect', '--format', '{{.Id}}', image], { allowFail: true })).code === 0;
}

/** Builds the given stacks, or all of them. The others build on aidev-base, so it always comes first. */
export async function buildImages(stacks: string[], noCache: boolean): Promise<void> {
  const unknown = stacks.filter((s) => !(STACKS as readonly string[]).includes(s));
  if (unknown.length) throw new Error(`Unknown image: ${unknown.join(', ')}. Choose from ${STACKS.join(', ')}.`);
  const order = STACKS.filter((s) => s === 'base' || stacks.length === 0 || stacks.includes(s));
  for (const stack of order) {
    console.log(`\nBuilding ${imageName(stack)}...`);
    const file = path.join(IMAGES_DIR, `${stack}.Dockerfile`);
    await exec('docker', ['build', ...(noCache ? ['--no-cache'] : []), '--file', file, '--tag', imageName(stack), IMAGES_DIR], {
      inherit: true,
    });
  }
}

export interface Mount {
  source: string;
  target: string;
  readonly?: boolean;
}

/**
 * The watchdog every agent container gets: Claude Code's managed settings, which run
 * src/watchdog/hook.ts before each tool call. Read-only, and managed settings outrank the repo's own.
 */
export const WATCHDOG_MOUNTS: Mount[] = [
  { source: WATCHDOG_DIR, target: '/opt/aidev', readonly: true },
  { source: path.join(WATCHDOG_DIR, 'managed-settings.json'), target: '/etc/claude-code/managed-settings.json', readonly: true },
];

export interface ContainerSpec {
  name: string;
  image: string;
  /** Host folders and files to mount. Nothing else from the host is visible inside. */
  mounts: Mount[];
  /** Names of variables copied from this process's environment, so their values stay off the command line. */
  env: string[];
  limits: Limits;
  labels: Record<string, string>;
  command: string[];
}

/** `docker run` arguments for an agent container. Every agent container is started through here. */
export function dockerRunArgs(spec: ContainerSpec): string[] {
  const args = [
    'run',
    '--rm',
    '--interactive',
    '--init',
    '--name',
    spec.name,
    // Non-root with no Linux capabilities and no way to gain privileges.
    '--user',
    '1000:1000',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--cpus',
    String(spec.limits.cpus),
    '--memory',
    spec.limits.memory,
    '--pids-limit',
    String(spec.limits.pids),
    '--workdir',
    '/work',
  ];
  for (const mount of spec.mounts) {
    if (mount.source.includes(',')) throw new Error(`Can't mount a folder whose path contains a comma: ${mount.source}`);
    args.push('--mount', `type=bind,source=${mount.source},target=${mount.target}${mount.readonly ? ',readonly' : ''}`);
  }
  for (const name of spec.env) args.push('--env', name);
  for (const [key, value] of Object.entries(spec.labels)) args.push('--label', `${key}=${value}`);
  args.push(spec.image, ...spec.command);
  return args;
}
