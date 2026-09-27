// Claude Code runs this before every tool call inside agent containers (see
// managed-settings.json). Exit code 2 blocks the call and shows the reason to the agent.
// It fails open: if this script breaks, the orchestrator's diff check still catches protected files.
import { checkToolUse } from './policy.ts';

let raw = '';
for await (const chunk of process.stdin) raw += chunk;
const event = JSON.parse(raw) as { tool_name?: string; tool_input?: Record<string, unknown> };
const patterns = JSON.parse(process.env.AIDEV_PROTECTED_PATHS ?? '[]') as string[];

const reason = checkToolUse(event.tool_name ?? '', event.tool_input ?? {}, patterns);
if (reason) {
  process.stderr.write(`Blocked by aidev: ${reason}\n`);
  process.exit(2);
}
