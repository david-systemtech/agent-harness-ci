import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { Worker, type ResourceLimits } from "node:worker_threads";
import type { ChallengeKind } from "@agent-harness/contracts";
import type { Clock } from "../serve/clock.js";
import type { BodyKind } from "./web-fetch.js";

/**
 * `web_read`'s extraction (browser spec, "`web_read`"): a fetched body read
 * into text in a fresh worker thread per call, under a 512 MB heap limit,
 * one call at a time per environment, so the memory a large page takes
 * (#292 measured jsdom and Readability at 326 MB over fifteen pages) goes
 * with the worker when the call ends. A page that breaks the reader, a
 * worker that runs out of its heap and one that outlasts its bound each
 * answer a sentence, never an exception (#696).
 */

/** The heap a worker may take, in megabytes. */
export const EXTRACTION_HEAP_MB = 512;

/** How long a worker may read before it is ended. */
export const EXTRACTION_TIMEOUT_MS = 30_000;

/** A range of a PDF's pages, both ends counted from 1 and included. */
export interface PageRange {
  readonly from: number;
  readonly to: number;
}

/** What a worker is handed: the body, its kind and declared type, the address it was read from, and the pages asked for. */
export interface ExtractionJob {
  readonly bodyKind: BodyKind;
  readonly bytes: Uint8Array;
  readonly contentType: string;
  readonly url: string;
  readonly pages: PageRange | null;
}

/** What a worker read: a challenge or a shell, an article, a page's or a text's own text, a PDF's pages, or why it could not. */
export type Extracted =
  | { readonly kind: "challenge"; readonly challenge: ChallengeKind }
  | { readonly kind: "shell" }
  | { readonly kind: "article" | "document" | "text"; readonly markdown: string }
  | { readonly kind: "pdf"; readonly markdown: string; readonly totalPages: number; readonly from: number; readonly to: number }
  | { readonly kind: "failed"; readonly reason: string };

/** A worker as the hooks see it: its thread, and the limits it runs under. */
export interface ExtractionWorker {
  readonly threadId: number;
  readonly resourceLimits: ResourceLimits;
}

/**
 * What a test observes of the workers: a call that waits for the one before
 * it, each worker as it starts (the call hands it the page once what
 * `started` returns settles, so a test can hold one) and as it has gone.
 */
export interface ExtractionHooks {
  readonly waiting?: () => void;
  readonly started?: (worker: ExtractionWorker) => void | Promise<void>;
  readonly ended?: (worker: ExtractionWorker) => void;
}

export interface Extractor {
  /** Reads `job` in a worker of its own once the calls before it are done; `signal` ends it early, answered with `abortReason`. */
  extract(job: ExtractionJob, signal: AbortSignal, abortReason: () => string): Promise<Extracted>;
}

/**
 * How a worker starts. Built, the worker is the compiled module beside this
 * one; run from source (the tests, a checkout run through tsx), it is the
 * TypeScript module, loaded through tsx's API with the workspace's source
 * condition, since a worker has no loader of its own.
 */
const startWorker = (resourceLimits: ResourceLimits): Worker => {
  const options = { resourceLimits, stdout: true, stderr: true } as const;
  if (!import.meta.url.endsWith(".ts")) return new Worker(new URL("./extract.worker.js", import.meta.url), options);
  const script = new URL("./extract.worker.ts", import.meta.url).href;
  const tsxApi = pathToFileURL(createRequire(import.meta.url).resolve("tsx/esm/api")).href;
  return new Worker(`import(${JSON.stringify(tsxApi)}).then(({ tsImport }) => tsImport(${JSON.stringify(script)}, ${JSON.stringify(script)}));`, {
    ...options,
    eval: true,
    execArgv: [...process.execArgv, "--conditions=@agent-harness/source"],
  });
};

/** The error code of a worker that ran out of its heap. */
const OUT_OF_MEMORY = "ERR_WORKER_OUT_OF_MEMORY";

/**
 * Reads `job` in `worker` once `ready` settles (what the `started` hook
 * returned), answering what it read or why it could not: within the bound,
 * which runs from the worker's start, and until `signal` aborts.
 */
const readIn = (worker: Worker, job: ExtractionJob, ready: Promise<void>, clock: Clock, signal: AbortSignal, abortReason: () => string): Promise<Extracted> =>
  new Promise((resolve) => {
    let settled = false;
    const finish = (extracted: Extracted): void => {
      if (settled) return;
      settled = true;
      timer.cancel();
      signal.removeEventListener("abort", aborted);
      resolve(extracted);
    };
    const aborted = () => finish({ kind: "failed", reason: abortReason() });
    const timer = clock.setTimeout(
      () => finish({ kind: "failed", reason: `Reading the page took longer than ${EXTRACTION_TIMEOUT_MS / 1000} seconds, and was stopped.` }),
      EXTRACTION_TIMEOUT_MS,
    );
    if (signal.aborted) return aborted();
    signal.addEventListener("abort", aborted, { once: true });
    worker.once("message", (extracted: Extracted) => finish(extracted));
    worker.once("error", (error: Error & { readonly code?: string }) =>
      finish({
        kind: "failed",
        reason:
          error.code === OUT_OF_MEMORY
            ? `Reading the page needed more than the ${EXTRACTION_HEAP_MB} MB a reader may take, and was stopped.`
            : `The reader failed: ${error.message}`,
      }),
    );
    worker.once("exit", () => finish({ kind: "failed", reason: "The reader stopped before it answered." }));
    // The body's own buffer moves to the worker rather than being copied.
    ready.then(
      () => {
        if (!settled) worker.postMessage(job, [job.bytes.buffer as ArrayBuffer]);
      },
      (error: unknown) => finish({ kind: "failed", reason: `The reader failed: ${String(error)}` }),
    );
  });

/** The environment's extractor: one worker at a time, a fresh one per call, ended as the call ends. */
export const createExtractor = (options: { readonly clock: Clock; readonly hooks?: ExtractionHooks }): Extractor => {
  const hooks = options.hooks ?? {};
  let queue: Promise<unknown> = Promise.resolve();
  let busy = 0;
  const run = async (job: ExtractionJob, signal: AbortSignal, abortReason: () => string): Promise<Extracted> => {
    if (signal.aborted) return { kind: "failed", reason: abortReason() };
    const worker = startWorker({ maxOldGenerationSizeMb: EXTRACTION_HEAP_MB });
    // What the reader's libraries print (pdf.js's warnings) is not the environment's to show.
    worker.stdout.resume();
    worker.stderr.resume();
    const seen: ExtractionWorker = { threadId: worker.threadId, resourceLimits: worker.resourceLimits ?? {} };
    try {
      return await readIn(worker, job, Promise.resolve(hooks.started?.(seen)), options.clock, signal, abortReason);
    } finally {
      await worker.terminate();
      hooks.ended?.(seen);
    }
  };
  return {
    extract(job, signal, abortReason) {
      if (busy > 0) hooks.waiting?.();
      busy++;
      const turn = queue.then(() => run(job, signal, abortReason));
      queue = turn.catch(() => undefined);
      return turn.finally(() => busy--);
    },
  };
};
