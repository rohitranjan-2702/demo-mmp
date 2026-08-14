"use client";

import { useEffect, useRef, useState } from "react";

type ContainerInfo = {
  name: string;
  id: string | null;
  state: string;
  status: string;
};

type LogEntry = {
  key: number;
  stream: "stdout" | "stderr";
  line: string;
};

const MAX_LINES = 2000;

const STATE_STYLES: Record<string, string> = {
  running: "bg-green-500",
  exited: "bg-zinc-400",
  "not found": "bg-zinc-300 dark:bg-zinc-700",
};

function stateDot(state: string): string {
  return STATE_STYLES[state] ?? "bg-yellow-500";
}

/** Container picker + live-tailing log panel for this project's
 *  docker-compose services, backed by /api/containers and /api/logs (SSE). */
export default function LogsViewer() {
  const [containers, setContainers] = useState<ContainerInfo[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [follow, setFollow] = useState(true);
  const [filter, setFilter] = useState("");

  // Load the container list once, auto-selecting the first running one.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/containers", { cache: "no-store" })
      .then((res) => res.json())
      .then((data) => {
        if (cancelled) return;
        const list: ContainerInfo[] = data.containers;
        setContainers(list);
        setSelected((prev) => prev ?? list.find((c) => c.state === "running")?.name ?? list[0]?.name ?? null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="flex min-h-0 flex-1 flex-row">
      <aside className="flex w-56 shrink-0 flex-col gap-1 overflow-y-auto border-r border-black/10 px-3 py-4 dark:border-white/10">
        <h2 className="mb-2 px-1 text-sm font-semibold tracking-tight text-black dark:text-zinc-50">
          Containers
        </h2>
        {(containers ?? []).map((c) => (
          <button
            key={c.name}
            onClick={() => setSelected(c.name)}
            className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm ${
              selected === c.name
                ? "bg-black/5 dark:bg-white/10"
                : "hover:bg-black/5 dark:hover:bg-white/5"
            }`}
          >
            <span className={`h-2 w-2 shrink-0 rounded-full ${stateDot(c.state)}`} />
            <span className="min-w-0 flex-1 truncate text-black dark:text-zinc-50">{c.name}</span>
          </button>
        ))}
        {!containers && (
          <p className="px-2 py-1.5 text-xs text-zinc-400">loading…</p>
        )}
      </aside>

      {selected ? (
        // Keyed by container name so switching containers mounts a fresh
        // LogPanel — its own lines/connected state starts clean instead of
        // needing to be reset imperatively from an effect.
        <LogPanel
          key={selected}
          name={selected}
          follow={follow}
          filter={filter}
          onFollowChange={setFollow}
          onFilterChange={setFilter}
        />
      ) : (
        <div className="flex flex-1 items-center justify-center text-sm text-zinc-500">
          pick a container on the left
        </div>
      )}
    </div>
  );
}

function LogPanel({
  name,
  follow,
  filter,
  onFollowChange,
  onFilterChange,
}: {
  name: string;
  follow: boolean;
  filter: string;
  onFollowChange: (follow: boolean) => void;
  onFilterChange: (filter: string) => void;
}) {
  const [lines, setLines] = useState<LogEntry[]>([]);
  const [connected, setConnected] = useState(false);

  const keyRef = useRef(0);
  const logPanelRef = useRef<HTMLDivElement | null>(null);

  // Stream this container's logs for as long as the panel is mounted.
  useEffect(() => {
    const source = new EventSource(`/api/logs?name=${encodeURIComponent(name)}`);

    source.addEventListener("open", () => setConnected(true));
    source.addEventListener("error", () => setConnected(false));

    source.addEventListener("log", (event) => {
      const { stream, line } = JSON.parse((event as MessageEvent).data);
      setLines((prev) => {
        const next = [...prev, { key: keyRef.current++, stream, line }];
        return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next;
      });
    });

    source.addEventListener("stream-error", (event) => {
      const { message } = JSON.parse((event as MessageEvent).data);
      setLines((prev) => [
        ...prev,
        { key: keyRef.current++, stream: "stderr", line: `[logs] ${message}` },
      ]);
    });

    return () => source.close();
  }, [name]);

  // Auto-scroll to bottom on new lines, unless the user scrolled up.
  useEffect(() => {
    if (!follow || !logPanelRef.current) return;
    logPanelRef.current.scrollTop = logPanelRef.current.scrollHeight;
  }, [lines, follow]);

  const visibleLines = filter
    ? lines.filter((l) => l.line.toLowerCase().includes(filter.toLowerCase()))
    : lines;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2 p-4">
      <div className="flex items-center gap-2">
        <h1 className="text-base font-semibold text-black dark:text-zinc-50">{name}</h1>
        <span
          className={`h-2 w-2 shrink-0 rounded-full ${connected ? "bg-green-500" : "bg-zinc-400 animate-pulse"}`}
          title={connected ? "streaming" : "connecting…"}
        />
        <div className="ml-auto flex items-center gap-2">
          <input
            value={filter}
            onChange={(e) => onFilterChange(e.target.value)}
            placeholder="Filter…"
            className="w-40 rounded-md border border-black/10 bg-transparent px-2 py-1 text-sm text-black outline-none dark:border-white/10 dark:text-zinc-50"
          />
          <button
            onClick={() => onFollowChange(!follow)}
            className={`rounded-md px-2 py-1 text-xs font-medium ${
              follow
                ? "bg-black/10 text-black dark:bg-white/10 dark:text-zinc-50"
                : "border border-black/10 text-zinc-500 dark:border-white/10 dark:text-zinc-400"
            }`}
          >
            Follow
          </button>
          <button
            onClick={() => setLines([])}
            className="rounded-md border border-black/10 px-2 py-1 text-xs font-medium text-zinc-500 dark:border-white/10 dark:text-zinc-400"
          >
            Clear
          </button>
        </div>
      </div>

      <div
        ref={logPanelRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
          if (!atBottom && follow) onFollowChange(false);
        }}
        className="min-h-0 flex-1 overflow-y-auto rounded-lg bg-zinc-950 p-3 font-mono text-xs leading-relaxed"
      >
        {visibleLines.map((l) => (
          <div key={l.key} className={l.stream === "stderr" ? "text-red-400" : "text-zinc-200"}>
            {l.line}
          </div>
        ))}
        {visibleLines.length === 0 && <p className="text-zinc-500">no log lines yet…</p>}
      </div>
    </div>
  );
}
