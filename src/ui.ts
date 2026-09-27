import { styleText } from 'node:util';

export const dim = (text: string) => styleText('dim', text);
export const red = (text: string) => styleText('red', text);
export const green = (text: string) => styleText('green', text);

export function step(title: string): void {
  console.log(`\n${styleText('bold', `== ${title}`)}`);
}

export function ok(message: string): void {
  console.log(`${green('✓')} ${message}`);
}

export function fail(message: string): void {
  console.log(`${red('✗')} ${message}`);
}

export function warn(message: string): void {
  console.log(styleText('yellow', `! ${message}`));
}

export function indent(text: string, prefix = '  '): string {
  return text
    .split('\n')
    .map((line) => prefix + line)
    .join('\n');
}

export function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  return minutes ? `${minutes}m ${String(seconds % 60).padStart(2, '0')}s` : `${seconds}s`;
}
