/**
 * How long a package's lint test gives its whole-package check: ESLint loads
 * the repository's configuration and lints every file of the package inside
 * one test, so the check grows with the package and with the runner's load.
 * On the agent box with other suites running (load 55 to 73 on 16 cores),
 * the client runtime's took up to 44 s and the terminal UI's up to 49 s, past
 * the 30 s every test gets (#626). About two and a half times the slowest
 * seen: only a lint that hangs waits it out, since one that finds a problem
 * fails once it has linted.
 */
export const WHOLE_PACKAGE_LINT_MS = 120_000;
