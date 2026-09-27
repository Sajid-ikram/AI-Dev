import { spawn } from 'node:child_process';

export interface ExecOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Written to the child's stdin, which is then closed. */
  input?: string;
  /** Stream output to this terminal instead of capturing it. */
  inherit?: boolean;
  /** Resolve with the exit code instead of throwing on failure. */
  allowFail?: boolean;
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs a program without a shell, so arguments reach it unmangled on Windows. */
export function exec(cmd: string, args: string[], opts: ExecOptions = {}): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const output = opts.inherit ? 'inherit' : 'pipe';
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: [opts.input === undefined ? 'ignore' : 'pipe', output, output],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8').on('data', (d: string) => (stdout += d));
    child.stderr?.setEncoding('utf8').on('data', (d: string) => (stderr += d));
    child.on('error', (err) => reject(new Error(`Could not start ${cmd}: ${err.message}`)));
    child.on('close', (code) => {
      const result = { code: code ?? 1, stdout, stderr };
      if (result.code !== 0 && !opts.allowFail) {
        const detail = (stderr.trim() || stdout.trim()).split('\n').slice(-15).join('\n');
        reject(new Error(`${cmd} ${args.join(' ')} failed with exit code ${result.code}${detail ? `:\n${detail}` : ''}`));
      } else {
        resolve(result);
      }
    });
    if (opts.input !== undefined) child.stdin!.end(opts.input);
  });
}
