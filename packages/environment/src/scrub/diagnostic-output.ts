/** What a stream the environment's diagnostics reach is to this module: something written to. */
export interface DiagnosticStream {
  write: NodeJS.WritableStream["write"];
}

/** One stream's scrub, shared by every environment running in the process while one does. */
interface Hook {
  /** The stream's own write, which every write reaches after the scrub. */
  readonly original: DiagnosticStream["write"];
  /** Whether `original` was the stream's own property rather than its prototype's. */
  readonly ownWrite: boolean;
  /** The write put in the stream's place. */
  readonly scrubbed: DiagnosticStream["write"];
  /** Each running environment's scrub, applied in turn. */
  readonly scrubs: Set<{ readonly scrub: (text: string) => string }>;
}

const hooks = new WeakMap<DiagnosticStream, Hook>();

const scrubbedText = (text: string, hook: Hook): string => {
  let scrubbed = text;
  for (const { scrub } of hook.scrubs) scrubbed = scrub(scrubbed);
  return scrubbed;
};

/** A chunk as it is written after the scrub: a string as a string, bytes as bytes (the same bytes when nothing was replaced), anything else as it is. */
const scrubbedChunk = (chunk: unknown, hook: Hook): unknown => {
  if (typeof chunk === "string") return scrubbedText(chunk, hook);
  if (!(chunk instanceof Uint8Array)) return chunk;
  const text = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength).toString("utf8");
  const scrubbed = scrubbedText(text, hook);
  return scrubbed === text ? chunk : Buffer.from(scrubbed, "utf8");
};

/**
 * Passes every write to the environment's diagnostic output, the process's
 * standard error, through `scrub` until the answer is called (ADR 0011;
 * key-managers spec, "Where it applies": the logger). What the console and
 * anything else in the process write there is scrubbed as one write, so a
 * line keeps whole what a console call printed, an error's message and
 * stack with it. The stream is shared by every environment in the process,
 * each adding its registry's scrub; the stream's own write is put back once
 * the last lets go, unless something has wrapped it since, when the scrub
 * stays in place and passes every write on as it is. `stream` is a seam for
 * the lower tests.
 */
export const scrubDiagnosticOutput = (scrub: (text: string) => string, stream: DiagnosticStream = process.stderr): (() => void) => {
  let hook = hooks.get(stream);
  if (hook === undefined) {
    const original = stream.write;
    const scrubs: Hook["scrubs"] = new Set();
    const made: Hook = {
      original,
      ownWrite: Object.hasOwn(stream, "write"),
      scrubs,
      scrubbed: ((chunk: unknown, ...rest: unknown[]) =>
        (original as (...args: unknown[]) => boolean).call(stream, scrubbedChunk(chunk, made), ...rest)) as DiagnosticStream["write"],
    };
    stream.write = made.scrubbed;
    hooks.set(stream, made);
    hook = made;
  }
  const held = hook;
  const entry = { scrub };
  held.scrubs.add(entry);
  return () => {
    if (!held.scrubs.delete(entry) || held.scrubs.size > 0) return;
    hooks.delete(stream);
    if (stream.write !== held.scrubbed) return;
    if (held.ownWrite) stream.write = held.original;
    else Reflect.deleteProperty(stream, "write");
  };
};
