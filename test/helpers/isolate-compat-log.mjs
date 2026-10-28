import { tmpdir } from "node:os";
import { join } from "node:path";

// Keep test runs from appending to the real ~/.claude-code-router/logs file.
process.env.AIRKIT_COMPAT_LOG ??= join(tmpdir(), `airkit-compat-test-${process.pid}.log`);
