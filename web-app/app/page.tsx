"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent } from "react";

import { readSse } from "./lib/sse";

type ToolActivity = {
  phase: "call" | "output";
  name: string;
  detail?: string;
};

const SUGGESTED_QUERIES = [
  "Which country has the most events?",
  "What is the most visited page?",
  "What is the average event duration by event type?",
];

/** Monotonic timestamp in ms, isolated in its own module-scope function so
 *  the React Compiler doesn't mistake this event-handler-only timing for an
 *  impure call during render. */
function now(): number {
  return performance.now();
}

export default function Home() {
  const [query, setQuery] = useState(SUGGESTED_QUERIES[0]);
  const [loading, setLoading] = useState(false);
  const [answer, setAnswer] = useState("");
  const [activity, setActivity] = useState<ToolActivity[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState<number | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const startedAtRef = useRef<number>(0);

  // Cancel any in-flight stream if the component unmounts mid-request.
  useEffect(() => () => abortRef.current?.abort(), []);

  async function runQuery(question: string) {
    const trimmed = question.trim();
    if (!trimmed || loading) return;

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    setAnswer("");
    setActivity([]);
    setError(null);
    setElapsedSeconds(null);

    try {
      const res = await fetch(
        `/api/ask?query=${encodeURIComponent(trimmed)}&stream=true`,
        { signal: controller.signal, headers: { Accept: "text/event-stream" } },
      );

      if (!res.body) {
        throw new Error("No response body");
      }

      for await (const frame of readSse(res.body)) {
        switch (frame.event) {
          case "token": {
            const { text } = frame.data as { text: string };
            setAnswer((prev) => prev + text);
            break;
          }
          case "tool_call": {
            const { name, arguments: args } = frame.data as {
              name: string;
              arguments?: string;
            };
            setActivity((prev) => [
              ...prev,
              { phase: "call", name, detail: args },
            ]);
            break;
          }
          case "tool_output": {
            const { name } = frame.data as { name: string; output: unknown };
            setActivity((prev) => [...prev, { phase: "output", name }]);
            break;
          }
          case "done": {
            const { answer: finalAnswer } = frame.data as { answer: string };
            setAnswer(finalAnswer);
            setElapsedSeconds((now() - startedAtRef.current) / 1000);
            break;
          }
          case "error": {
            const { error: message } = frame.data as { error: string };
            setError(message);
            break;
          }
        }
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (abortRef.current === controller) {
        setLoading(false);
      }
    }
  }

  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    startedAtRef.current = now();
    runQuery(query);
  }

  function handleSuggestion(suggestion: string) {
    setQuery(suggestion);
    startedAtRef.current = now();
    runQuery(suggestion);
  }

  return (
    <div className="flex flex-col flex-1 items-center bg-zinc-50 font-sans dark:bg-black">
      <main className="flex w-full max-w-2xl flex-col gap-8 px-6 py-24 sm:px-8">
        <div className="flex flex-col gap-2 text-center sm:text-left">
          <h1 className="text-2xl font-semibold tracking-tight text-black dark:text-zinc-50">
            Ask your data
          </h1>
          <p className="text-zinc-600 dark:text-zinc-400">
            Ask a question in plain English and get an answer straight from
            the database.{" "}
            <Link href="/simulate" className="font-medium underline underline-offset-2">
              Simulate events
            </Link>
            {" · "}
            <Link href="/logs" className="font-medium underline underline-offset-2">
              View logs
            </Link>
          </p>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-3 sm:flex-row">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Ask your query"
            className="flex-1 rounded-lg border border-black/10 bg-white px-4 py-3 text-black outline-none focus:border-black/30 dark:border-white/10 dark:bg-zinc-900 dark:text-zinc-50 dark:focus:border-white/30"
          />
          <button
            type="submit"
            disabled={loading || !query.trim()}
            className="rounded-lg bg-foreground px-6 py-3 font-medium text-background transition-colors hover:bg-[#383838] disabled:cursor-not-allowed disabled:opacity-50 dark:hover:bg-[#ccc]"
          >
            {loading ? "Asking..." : "Ask"}
          </button>
        </form>

        <div className="flex flex-wrap gap-2">
          {SUGGESTED_QUERIES.map((suggestion) => (
            <button
              key={suggestion}
              type="button"
              onClick={() => handleSuggestion(suggestion)}
              disabled={loading}
              className="rounded-full border border-black/10 px-3 py-1.5 text-sm text-zinc-600 transition-colors hover:border-black/30 hover:text-black disabled:cursor-not-allowed disabled:opacity-50 dark:border-white/10 dark:text-zinc-400 dark:hover:border-white/30 dark:hover:text-zinc-50"
            >
              {suggestion}
            </button>
          ))}
        </div>

        {activity.length > 0 && (
          <ul className="flex flex-col gap-1 text-sm text-zinc-500 dark:text-zinc-400">
            {activity.map((a, i) => (
              <li key={i}>
                {a.phase === "call"
                  ? `→ calling ${a.name}${a.detail ? `(${a.detail})` : ""}`
                  : `← ${a.name} returned`}
              </li>
            ))}
          </ul>
        )}

        {(answer || error || loading) && (
          <div className="flex flex-col gap-2 rounded-lg border border-black/10 bg-white p-5 dark:border-white/10 dark:bg-zinc-900">
            {error ? (
              <p className="text-red-600 dark:text-red-400">{error}</p>
            ) : (
              <p className="whitespace-pre-wrap text-black dark:text-zinc-50">
                {answer}
                {loading && (
                  <span className="ml-0.5 inline-block animate-pulse">▍</span>
                )}
              </p>
            )}
            {elapsedSeconds !== null && !error && (
              <p className="text-sm text-zinc-500 dark:text-zinc-400">
                Answered in {elapsedSeconds.toFixed(1)} seconds
              </p>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
