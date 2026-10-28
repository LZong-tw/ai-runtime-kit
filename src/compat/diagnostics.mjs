import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// The compatibility gateway also runs inside the airclaude launcher, whose
// stderr is the terminal Claude Code draws on, so diagnostics go to a file.
export function compatLogPath(env = process.env) {
  if (typeof env.AIRKIT_COMPAT_LOG === "string" && env.AIRKIT_COMPAT_LOG.length > 0) return env.AIRKIT_COMPAT_LOG;
  return join(env.HOME || homedir(), ".claude-code-router", "logs", "airkit-compat.log");
}

export function formatCompatLine(tag, record) {
  return `[${tag}] ${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`;
}

// Called as compatLog.write(...) so tests can mock the method across modules.
export const compatLog = {
  write(tag, record, env = process.env) {
    try {
      const path = compatLogPath(env);
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      appendFileSync(path, formatCompatLine(tag, record), { mode: 0o600 });
    } catch {
      // Diagnostics must never break a request.
    }
  },
};
