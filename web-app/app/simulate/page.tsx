"use client";

import Link from "next/link";
import { useRef, useState } from "react";

type EventBody = {
  id: number;
  event_type: string;
  user_id: number;
  page: string;
  country: string;
  duration_ms: number;
};

type LogEntry = {
  key: number;
  payload: EventBody;
  status: "pending" | "success" | "error";
  message?: string;
};

const EVENT_TYPES = ["pageview", "click"];
const PAGES = ["/home", "/user", "/dashboard", "/settings"];
const COUNTRIES = ["India", "USA", "Japan", "China", "Nepal"];

/** All the randomness lives in this one module-scope helper: the React
 *  Compiler's purity rule flags Math.random()/Date.now() calls written
 *  lexically inside a component, even inside its event handlers. */
function randomEvent(): EventBody {
  const pick = <T,>(options: T[]) =>
    options[Math.floor(Math.random() * options.length)];

  return {
    id: Math.floor(Math.random() * 1_000_000),
    event_type: pick(EVENT_TYPES),
    user_id: Math.floor(Math.random() * 1000) + 1,
    page: pick(PAGES),
    country: pick(COUNTRIES),
    duration_ms: Math.floor(Math.random() * 10_000),
  };
}

export default function Simulate() {
  const [log, setLog] = useState<LogEntry[]>([]);
  const keyRef = useRef(0);

  async function sendEvent() {
    const key = keyRef.current++;
    const payload = randomEvent();

    setLog((prev) => [{ key, payload, status: "pending" }, ...prev]);

    try {
      const res = await fetch("/api/simulate-event", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();

      setLog((prev) =>
        prev.map((entry) =>
          entry.key === key
            ? {
                ...entry,
                status: res.ok && data.success ? "success" : "error",
                message: data.error ? JSON.stringify(data.error) : undefined,
              }
            : entry,
        ),
      );
    } catch (err) {
      setLog((prev) =>
        prev.map((entry) =>
          entry.key === key
            ? {
                ...entry,
                status: "error",
                message: err instanceof Error ? err.message : String(err),
              }
            : entry,
        ),
      );
    }
  }

  return (
    <div className="flex flex-col flex-1 items-center bg-zinc-50 font-sans dark:bg-black">
      <main className="flex w-full max-w-2xl flex-col gap-8 px-6 py-24 sm:px-8">
        <div className="flex flex-col gap-2 text-center sm:text-left">
          <h1 className="text-2xl font-semibold tracking-tight text-black dark:text-zinc-50">
            Simulate events
          </h1>
          <p className="text-zinc-600 dark:text-zinc-400">
            Each click sends one random event to the producer.{" "}
            <Link href="/" className="font-medium underline underline-offset-2">
              Back to Ask your data
            </Link>
            {" · "}
            <Link href="/logs" className="font-medium underline underline-offset-2">
              View logs
            </Link>
          </p>
        </div>

        <button
          type="button"
          onClick={sendEvent}
          className="self-start rounded-lg bg-foreground px-6 py-3 font-medium text-background transition-colors hover:bg-[#383838] dark:hover:bg-[#ccc]"
        >
          Simulate event
        </button>

        {log.length > 0 && (
          <ul className="flex flex-col gap-2">
            {log.map((entry) => (
              <li
                key={entry.key}
                className="flex flex-col gap-1 rounded-lg border border-black/10 bg-white p-4 text-sm dark:border-white/10 dark:bg-zinc-900"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-xs text-zinc-500 dark:text-zinc-400">
                    id={entry.payload.id} user_id={entry.payload.user_id}
                  </span>
                  <span
                    className={
                      entry.status === "success"
                        ? "text-green-600 dark:text-green-400"
                        : entry.status === "error"
                          ? "text-red-600 dark:text-red-400"
                          : "text-zinc-500 dark:text-zinc-400"
                    }
                  >
                    {entry.status === "pending"
                      ? "sending..."
                      : entry.status === "success"
                        ? "sent"
                        : "failed"}
                  </span>
                </div>
                <span className="text-black dark:text-zinc-50">
                  {entry.payload.event_type} · {entry.payload.page} ·{" "}
                  {entry.payload.country} · {entry.payload.duration_ms}ms
                </span>
                {entry.message && (
                  <span className="text-red-600 dark:text-red-400">
                    {entry.message}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </main>
    </div>
  );
}
