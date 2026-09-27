import { parseArgs } from 'node:util';
import { loadEnv } from './config.ts';
import { buildImages, imageName } from './docker.ts';
import { runTicket } from './pipeline.ts';
import { publishJob } from './publish.ts';
import { sandboxTest } from './sandbox.ts';
import { red } from './ui.ts';

const HELP = `aidev sends Jira tickets to a Claude Code agent in a sandbox.

Usage:
  aidev run <KEY> [--project <name|file.yaml>] [--ticket-file <file.md>] [--fresh] [--local]
      Fetch the ticket and clone the repo. Then, for up to 3 rounds: the worker agent implements
      it, the project's checks run, and a separate reviewer agent reviews it. Approved work is
      pushed as a pull request, and the outcome is commented on the Jira ticket.
      --ticket-file reads the ticket from a Markdown file instead of Jira.
      --fresh deletes the job folder from an earlier run of the same ticket.
      --local keeps everything on this PC: no push, pull request or Jira comment.

  aidev publish <KEY>
      Push an approved job and open its pull request, for example after --local or a failed push.

  aidev build [base|node|flutter...] [--no-cache]
      Build the agent images. With no names, builds all of them.

  aidev sandbox-test [--image <image>] [--agent]
      Check that an agent container can't reach the Windows host.
      --agent also asks Claude to try, which needs the Claude credential in .env.
`;

async function main(argv: string[]): Promise<number> {
  loadEnv();
  const [command, ...rest] = argv;
  switch (command) {
    case 'run': {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: {
          project: { type: 'string' },
          'ticket-file': { type: 'string' },
          fresh: { type: 'boolean', default: false },
          local: { type: 'boolean', default: false },
        },
      });
      if (positionals.length !== 1) return usage('run takes exactly one issue key, such as POT-12.');
      return runTicket({
        key: positionals[0].toUpperCase(),
        project: values.project,
        ticketFile: values['ticket-file'],
        fresh: values.fresh,
        local: values.local,
      });
    }
    case 'publish': {
      const { positionals } = parseArgs({ args: rest, allowPositionals: true, options: {} });
      if (positionals.length !== 1) return usage('publish takes exactly one issue key, such as POT-12.');
      return publishJob(positionals[0].toUpperCase());
    }
    case 'build': {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: { 'no-cache': { type: 'boolean', default: false } },
      });
      await buildImages(positionals, values['no-cache']);
      return 0;
    }
    case 'sandbox-test': {
      const { values } = parseArgs({
        args: rest,
        options: { image: { type: 'string', default: imageName('base') }, agent: { type: 'boolean', default: false } },
      });
      return sandboxTest({ image: values.image, agent: values.agent });
    }
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      console.log(HELP);
      return 0;
    default:
      return usage(`Unknown command "${command}".`);
  }
}

function usage(message: string): number {
  console.error(`${red(message)}\n\n${HELP}`);
  return 2;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    console.error(red(`Error: ${err instanceof Error ? err.message : String(err)}`));
    process.exitCode = 1;
  },
);
