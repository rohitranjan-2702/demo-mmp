import type { NextRequest } from "next/server";

const SMART_ANALYSIS_URL =
  process.env.SMART_ANALYSIS_URL ?? "http://localhost:3030";

// Route Handlers cache GET by default; this proxies live, per-request data.
export const dynamic = "force-dynamic";

/**
 * Proxies to the smart-analysis service's `/ask` endpoint so the browser
 * only ever talks to same-origin Next.js (the service has no CORS headers).
 *
 * With `?stream=true` the upstream SSE body is piped straight through;
 * otherwise the full JSON `{ query, answer }` response is relayed as-is.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const query = searchParams.get("query");
  const stream = searchParams.get("stream") === "true";

  if (!query) {
    return Response.json({ error: "Missing query parameter" }, { status: 400 });
  }

  const upstream = new URL("/ask", SMART_ANALYSIS_URL);
  upstream.searchParams.set("query", query);
  if (stream) upstream.searchParams.set("stream", "true");

  if (stream) {
    const res = await fetch(upstream, {
      signal: request.signal,
      headers: { Accept: "text/event-stream" },
    });

    if (!res.body) {
      return Response.json(
        { query, error: "Upstream returned no stream" },
        { status: 502 },
      );
    }

    return new Response(res.body, {
      status: res.status,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  }

  try {
    const res = await fetch(upstream, { signal: request.signal });
    const data = await res.json();
    return Response.json(data, { status: res.status });
  } catch (err) {
    return Response.json(
      {
        query,
        error: err instanceof Error ? err.message : String(err),
      },
      { status: 502 },
    );
  }
}
