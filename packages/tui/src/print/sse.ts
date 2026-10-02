/**
 * The data of a completions answer's server-sent events, as the surface
 * writes them (claude-adapter spec, "The completions surface": streaming):
 * each event's `data:` lines joined, however the bytes were cut on the
 * way; a comment (the surface's keep-alive) and an event with no data
 * yield nothing, and `[DONE]` ends the answer. An event the stream ended
 * in the middle of is not one.
 */
export async function* eventData(body: ReadableStream<Uint8Array>): AsyncGenerator<string, void, undefined> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffered = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buffered += decoder.decode(value, { stream: true });
      let end = buffered.indexOf("\n\n");
      while (end >= 0) {
        const event = buffered.slice(0, end);
        buffered = buffered.slice(end + 2);
        end = buffered.indexOf("\n\n");
        const data = event
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(line.startsWith("data: ") ? 6 : 5));
        if (data.length === 0) continue;
        const joined = data.join("\n");
        if (joined === "[DONE]") return;
        yield joined;
      }
    }
  } finally {
    // Done with the answer, read to its end or not: the connection is let go.
    await reader.cancel().catch(() => undefined);
  }
}
