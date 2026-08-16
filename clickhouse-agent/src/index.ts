import type { ServerResponse } from "node:http";

import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";

import { ask, askStream } from "./lib/agent";
import { runReadOnlySql, SQL_LIMITS } from "./lib/clickhouse";
import { SqlGuardError } from "./lib/sqlGuard";

const fastify = Fastify({
  logger: true,
});

/** Serialized tool output is capped so one big result set can't flood the wire. */
const MAX_SSE_DATA_BYTES = 8_000;

/**
 * Write one SSE frame. `data` is JSON on a single line, so no escaping of
 * newlines is needed beyond what JSON.stringify already does.
 */
function sendEvent(raw: ServerResponse, event: string, data: unknown): void {
  let payload = JSON.stringify(data);

  if (payload.length > MAX_SSE_DATA_BYTES) {
    payload = JSON.stringify({
      truncated: true,
      preview: payload.slice(0, MAX_SSE_DATA_BYTES),
    });
  }

  raw.write(`event: ${event}\ndata: ${payload}\n\n`);
}

/**
 * Answer a question as Server-Sent Events: `token` frames as the model writes,
 * `tool_call`/`tool_output` frames as it queries ClickHouse, then a final
 * `done` frame with the complete answer (or an `error` frame if the run blew up).
 */
async function streamAnswer(
  request: FastifyRequest,
  reply: FastifyReply,
  query: string,
): Promise<void> {
  reply.hijack();

  const { raw } = reply;

  raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    // Tells nginx and friends not to buffer the response.
    "X-Accel-Buffering": "no",
  });

  const abort = new AbortController();
  raw.on("close", () => abort.abort());

  sendEvent(raw, "start", { query });

  try {
    for await (const event of askStream(query, abort.signal)) {
      const { type, ...data } = event;
      sendEvent(raw, type, data);
    }
  } catch (err) {
    if (!abort.signal.aborted) {
      request.log.error(err, "agent stream failed");
      sendEvent(raw, "error", {
        query,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  } finally {
    raw.end();
  }
}

fastify.get("/", function (request, reply) {
  reply.send({ hello: "world" });
});

fastify.get<{ Querystring: { query: string; stream?: boolean } }>(
  "/ask",
  {
    schema: {
      querystring: {
        type: "object",
        required: ["query"],
        properties: {
          query: { type: "string", minLength: 1 },
          stream: { type: "boolean", default: false },
        },
      },
    },
  },
  async function (request, reply) {
    const { query, stream } = request.query;

    if (stream || request.headers.accept?.includes("text/event-stream")) {
      return streamAnswer(request, reply, query);
    }

    try {
      const answer = await ask(query);
      return { query, answer };
    } catch (err) {
      request.log.error(err, "agent run failed");
      return reply.code(502).send({
        query,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },
);

fastify.post<{ Body: { sql: string; maxRows?: number } }>(
  "/sql",
  {
    schema: {
      body: {
        type: "object",
        required: ["sql"],
        properties: {
          sql: { type: "string", minLength: 1 },
          maxRows: {
            type: "integer",
            minimum: 1,
            maximum: SQL_LIMITS.maxRows,
          },
        },
      },
    },
  },
  async function (request, reply) {
    const { sql, maxRows } = request.body;

    try {
      return await runReadOnlySql(sql, { maxRows });
    } catch (err) {
      if (err instanceof SqlGuardError) {
        return reply.code(400).send({ sql, error: err.message });
      }

      request.log.error(err, "read-only sql failed");
      return reply.code(502).send({
        sql,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },
);

fastify.listen(
  { port: Number(process.env.PORT), host: "0.0.0.0" },
  async function (err, address) {
    if (err) {
      fastify.log.error(err);
      process.exit(1);
    }
  },
);
