import { Agent, run, type RunStreamEvent } from "@openai/agents";

import { clickhouseTools } from "./tools";

export const clickhouseAgent = new Agent({
  name: "Clickhouse Agent",
  model: process.env.OPENAI_MODEL ?? "gpt-5",
  instructions: [
    "You answer questions about analytics data stored in ClickHouse.",
    "Always call a tool to get facts — never guess a schema, a table name or a number.",
    "Start with list_tables to see what exists, then describe_table before reasoning about any table,",
    "then run_sql to compute the actual answer with a read-only SELECT,",
    "and use get_query_history to inspect queries that already ran or to explain a slow or failing query.",
    "Push the work into SQL — aggregate, filter and bucket server-side rather than selecting raw rows and counting them yourself.",
    "run_sql only accepts a single SELECT and caps rows and execution time; if it rejects a query, fix the SQL it complains about instead of trying to work around the restriction.",
    "If a tool returns an error or a hint, read it and retry with corrected arguments rather than giving up.",
    "Answer in a few plain-English sentences, quoting the numbers, column names and table names you actually saw.",
    "If the tools cannot answer the question, say exactly what is missing instead of inventing data.",
  ].join(" "),
  tools: [...clickhouseTools],
});

export async function ask(question: string): Promise<string> {
  const result = await run(clickhouseAgent, question);
  return result.finalOutput ?? "";
}

/** One SSE-shaped update from a streamed agent run. */
export type AskEvent =
  | { type: "token"; text: string }
  | { type: "tool_call"; name: string; arguments?: string }
  | { type: "tool_output"; name: string; output: unknown }
  | { type: "done"; answer: string };

/**
 * Run the agent and yield progress as it happens: text deltas as the model
 * writes them, plus the tool calls it makes along the way so a caller can show
 * what the agent is doing during the long gaps between tokens.
 */
export async function* askStream(
  question: string,
  signal?: AbortSignal,
): AsyncGenerator<AskEvent> {
  const stream = await run(clickhouseAgent, question, { stream: true, signal });

  for await (const event of stream) {
    const mapped = toAskEvent(event);
    if (mapped) {
      yield mapped;
    }
  }

  // Surfaces an error raised mid-run rather than ending on a silent half-answer.
  await stream.completed;

  yield { type: "done", answer: stream.finalOutput ?? "" };
}

function toAskEvent(event: RunStreamEvent): AskEvent | undefined {
  if (event.type === "raw_model_stream_event") {
    return event.data.type === "output_text_delta"
      ? { type: "token", text: event.data.delta }
      : undefined;
  }

  if (event.type !== "run_item_stream_event") {
    return undefined;
  }

  if (event.name === "tool_called") {
    const raw = event.item.rawItem as {
      name?: string;
      arguments?: string;
    };

    return {
      type: "tool_call",
      name: raw.name ?? "tool",
      arguments: raw.arguments,
    };
  }

  if (event.name === "tool_output") {
    const raw = event.item.rawItem as { name?: string };

    return {
      type: "tool_output",
      name: raw.name ?? "tool",
      output: (event.item as { output?: unknown }).output,
    };
  }

  return undefined;
}
