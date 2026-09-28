import { describe, expect, it } from "vitest";
import { scrubDiagnosticOutput, type DiagnosticStream } from "./diagnostic-output.js";

/**
 * The diagnostic output's scrub at its lower seam: a stream standing in for
 * the process's standard error, whose writes the test reads as they arrive.
 */

/** A stream whose write, on its prototype as `process.stderr`'s is, records what reaches it. */
class RecordingStream implements DiagnosticStream {
  readonly written: { chunk: unknown; rest: unknown[] }[] = [];

  write(chunk: unknown, ...rest: unknown[]): boolean {
    this.written.push({ chunk, rest });
    return true;
  }
}

const recording = (): RecordingStream & DiagnosticStream => new RecordingStream() as RecordingStream & DiagnosticStream;

const hiding =
  (secret: string) =>
  (text: string): string =>
    text.replaceAll(secret, "[redacted]");

describe("the diagnostic output's scrub", () => {
  it("scrubs a string written, passing its encoding and callback on", () => {
    const stream = recording();
    scrubDiagnosticOutput(hiding("s3cret-value"), stream);
    const callback = () => undefined;
    stream.write("the key is s3cret-value\n", "utf8", callback);
    expect(stream.written).toEqual([{ chunk: "the key is [redacted]\n", rest: ["utf8", callback] }]);
  });

  it("scrubs bytes as bytes, and passes bytes with nothing to replace on as the same bytes", () => {
    const stream = recording();
    scrubDiagnosticOutput(hiding("s3cret-value"), stream);
    const plain = Buffer.from("nothing here\n");
    stream.write(plain);
    stream.write(new TextEncoder().encode("bytes s3cret-value\n"));
    expect(stream.written[0]?.chunk).toBe(plain);
    expect(Buffer.from(stream.written[1]?.chunk as Uint8Array).toString("utf8")).toBe("bytes [redacted]\n");
  });

  it("applies every environment's scrub while each runs, and puts the stream's own write back once the last lets go", () => {
    const stream = recording();
    const own = stream.write;
    const first = scrubDiagnosticOutput(hiding("first-secret"), stream);
    const second = scrubDiagnosticOutput(hiding("second-secret"), stream);
    stream.write("first-secret second-secret");
    first();
    first();
    stream.write("first-secret second-secret");
    second();
    stream.write("first-secret second-secret");
    expect(stream.written.map(({ chunk }) => chunk)).toEqual(["[redacted] [redacted]", "first-secret [redacted]", "first-secret second-secret"]);
    expect(stream.write).toBe(own);
    expect(Object.hasOwn(stream, "write")).toBe(false);
  });

  it("puts back a write that was the stream's own property", () => {
    const written: unknown[] = [];
    const own = (chunk: unknown) => written.push(chunk) > 0;
    const stream = { write: own } as DiagnosticStream;
    scrubDiagnosticOutput(hiding("s3cret-value"), stream)();
    expect(stream.write).toBe(own);
  });

  it("stays in place, passing writes on as they are, when something wrapped the stream's write after it", () => {
    const stream = recording();
    const release = scrubDiagnosticOutput(hiding("s3cret-value"), stream);
    const scrubbed = stream.write;
    const wrapper = ((chunk: unknown, ...rest: unknown[]) => (scrubbed as (...args: unknown[]) => boolean)(`wrapped ${String(chunk)}`, ...rest)) as DiagnosticStream["write"];
    stream.write = wrapper;
    release();
    expect(stream.write).toBe(wrapper);
    stream.write("s3cret-value");
    expect(stream.written.map(({ chunk }) => chunk)).toEqual(["wrapped s3cret-value"]);

    // A later environment scrubs over the wrapper.
    scrubDiagnosticOutput(hiding("s3cret-value"), stream);
    stream.write("s3cret-value");
    expect(stream.written.at(-1)?.chunk).toBe("wrapped [redacted]");
  });
});
