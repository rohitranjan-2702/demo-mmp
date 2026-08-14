import type { NextRequest } from "next/server";

import { PROJECT_CONTAINERS } from "../../lib/health";
import { streamContainerLogs } from "../../lib/docker";

// Live log tail — never cache this route.
export const dynamic = "force-dynamic";

const encoder = new TextEncoder();

function sseFrame(event: string, data: unknown): Uint8Array {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/**
 * Streams a single container's combined stdout/stderr as Server-Sent
 * Events. `?name=` must be one of this project's own containers — the
 * mounted Docker socket can technically reach anything on the host, so this
 * is the guard that keeps the route scoped to this project.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const name = searchParams.get("name");
  const tail = Number(searchParams.get("tail") ?? "200") || 200;

  if (!name || !PROJECT_CONTAINERS.includes(name)) {
    return Response.json({ error: "Unknown or missing container name" }, { status: 400 });
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const { stream: kind, line } of streamContainerLogs(name, {
          signal: request.signal,
          tail,
        })) {
          controller.enqueue(sseFrame("log", { stream: kind, line }));
        }
        controller.close();
      } catch (err) {
        // Named "stream-error", not "error" — EventSource already fires a
        // built-in "error" event on network failures, and reusing that name
        // for an application-level SSE frame would collide with it client-side.
        controller.enqueue(
          sseFrame("stream-error", {
            message: err instanceof Error ? err.message : String(err),
          }),
        );
        controller.close();
      }
    },
    cancel() {
      // AbortSignal on request.signal already tears down the underlying
      // Docker stream inside streamContainerLogs; nothing else to do here.
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
