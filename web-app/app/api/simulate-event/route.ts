const PRODUCER_URL = process.env.PRODUCER_URL ?? "http://localhost:8001";

/**
 * Proxies to the producer service's `/event` endpoint so the browser only
 * ever talks to same-origin Next.js (the producer has no CORS headers).
 */
export async function POST(request: Request) {
  const body = await request.text();

  try {
    const res = await fetch(new URL("/event", PRODUCER_URL), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: request.signal,
    });

    const data = await res.json();
    return Response.json(data, { status: res.status });
  } catch (err) {
    return Response.json(
      { success: false, error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
}
