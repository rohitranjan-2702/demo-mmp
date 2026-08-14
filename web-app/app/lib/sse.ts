/** One parsed Server-Sent Event frame: an `event:` name plus its JSON `data:`. */
type SseFrame = { event: string; data: unknown };

/**
 * Reads a `text/event-stream` response body and yields each frame as it
 * arrives. Frames are separated by a blank line; multi-line `data:` fields
 * are joined with `\n` per the SSE spec.
 */
export async function* readSse(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<SseFrame> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let separator: number;
    while ((separator = buffer.indexOf("\n\n")) !== -1) {
      const raw = buffer.slice(0, separator);
      buffer = buffer.slice(separator + 2);

      let event = "message";
      const dataLines: string[] = [];

      for (const line of raw.split("\n")) {
        if (line.startsWith("event:")) {
          event = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).trim());
        }
      }

      if (dataLines.length > 0) {
        yield { event, data: JSON.parse(dataLines.join("\n")) };
      }
    }
  }
}
