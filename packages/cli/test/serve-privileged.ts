/**
 * The CLI with its user check wired to "privileged", for the refusal test.
 * Test-only: it is not under `src/`, so it is never built or shipped, and it
 * can only add a refusal, never lift one.
 */
import { runCli } from "../src/cli.js";

process.exitCode = await runCli(process.argv.slice(2), { environment: { user: { isPrivileged: () => true } } });
