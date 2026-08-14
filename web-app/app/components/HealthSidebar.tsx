"use client";

import { useEffect, useState } from "react";

type HealthResult = {
  name: string;
  status: "healthy" | "unhealthy";
  latencyMs: number;
  error?: string;
};

const POLL_INTERVAL_MS = 5_000;

const STATUS_STYLES: Record<HealthResult["status"] | "checking", string> = {
  healthy: "bg-green-500",
  unhealthy: "bg-red-500",
  checking: "bg-zinc-400 animate-pulse",
};

/** Polls `/api/health` on a fixed interval and lists every backend
 *  container's up/down status — kafka, clickhouse, producer, consumer, etc. */
export default function HealthSidebar() {
  const [results, setResults] = useState<HealthResult[] | null>(null);
  const [checkedAt, setCheckedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      try {
        const res = await fetch("/api/health", { cache: "no-store" });
        const data = await res.json();
        if (cancelled) return;
        setResults(data.results);
        setCheckedAt(data.checkedAt);
        setError(null);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      }
    }

    poll();
    const id = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const healthyCount = results?.filter((r) => r.status === "healthy").length ?? 0;

  return (
    <aside className="flex w-64 shrink-0 flex-col gap-4 border-r border-black/10 bg-white px-4 py-6 dark:border-white/10 dark:bg-zinc-950">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold tracking-tight text-black dark:text-zinc-50">
          Services
        </h2>
        {results && (
          <span className="text-xs text-zinc-500 dark:text-zinc-400">
            {healthyCount}/{results.length}
          </span>
        )}
      </div>

      {error && (
        <p className="text-xs text-red-600 dark:text-red-400">{error}</p>
      )}

      <ul className="flex flex-col gap-1">
        {(results ?? []).map((r) => (
          <li
            key={r.name}
            title={r.error}
            className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5 text-sm"
          >
            <span className="flex items-center gap-2 text-black dark:text-zinc-50">
              <span
                className={`h-2 w-2 shrink-0 rounded-full ${STATUS_STYLES[r.status]}`}
              />
              {r.name}
            </span>
            <span className="text-xs text-zinc-500 dark:text-zinc-400">
              {r.status === "healthy" ? `${r.latencyMs}ms` : "down"}
            </span>
          </li>
        ))}
        {!results &&
          !error &&
          Array.from({ length: 6 }).map((_, i) => (
            <li
              key={i}
              className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-zinc-400"
            >
              <span className={`h-2 w-2 shrink-0 rounded-full ${STATUS_STYLES.checking}`} />
              checking…
            </li>
          ))}
      </ul>

      {checkedAt && (
        <p className="mt-auto text-xs text-zinc-400 dark:text-zinc-600">
          Last checked {new Date(checkedAt).toLocaleTimeString()}
        </p>
      )}
    </aside>
  );
}
