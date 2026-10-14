/** The provider id of Codex accounts (ADR 0018, #2169): one `CODEX_HOME` directory each. */
export const CODEX_PROVIDER = "codex";

/** The variable the codex CLI reads its home from (`auth.json`, `config.toml`, sessions); `~/.codex` without it. */
export const CODEX_HOME = "CODEX_HOME";

/** The variable the codex-workers skill (david/agent-skills) reads first, before `CODEX_HOME` and `~/.codex`. */
export const CODEX_WORKER_HOME = "CODEX_WORKER_HOME";

/** The managed tool's name, as it is found on the PATH. */
export const CODEX_TOOL = "codex";
