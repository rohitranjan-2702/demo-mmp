import { PassThrough } from "node:stream";

import Docker from "dockerode";

import { PROJECT_CONTAINERS } from "./health";

// Default socketPath (`/var/run/docker.sock`) works both inside the
// web-app container (mounted in docker-compose.yml) and on the host under
// `next dev` (Docker Desktop exposes the same path on macOS/Linux) — same
// dual-environment approach as lib/health.ts's localhost fallbacks.
const docker = new Docker();

export type ContainerInfo = {
  name: string;
  id: string | null;
  state: string;
  status: string;
};

/**
 * Lists this project's containers (from PROJECT_CONTAINERS), in that fixed
 * order. Containers that don't exist (e.g. never started, or the one-shot
 * `kafka-init`) are reported as a synthetic "not found" state rather than
 * omitted, so the UI can still show them greyed out.
 */
export async function listProjectContainers(): Promise<ContainerInfo[]> {
  const containers = await docker.listContainers({ all: true });

  const byName = new Map(
    containers.map((c) => {
      // Docker prefixes container names with "/"; compose sets one name
      // per container via `container_name`, so `[0]` is always it.
      const name = c.Names[0]?.replace(/^\//, "") ?? c.Id;
      return [name, c];
    }),
  );

  return PROJECT_CONTAINERS.map((name) => {
    const c = byName.get(name);
    if (!c) {
      return { name, id: null, state: "not found", status: "not found" };
    }
    return { name, id: c.Id, state: c.State, status: c.Status };
  });
}

export type LogLine = { stream: "stdout" | "stderr"; line: string };

/**
 * Follows a container's combined stdout/stderr log, yielding one line at a
 * time. Resolves (stops yielding) when `signal` aborts — the caller is
 * responsible for closing whatever it's forwarding lines into.
 */
export async function* streamContainerLogs(
  name: string,
  { signal, tail = 200 }: { signal: AbortSignal; tail?: number },
): AsyncGenerator<LogLine> {
  const container = docker.getContainer(name);

  const rawStream = (await container.logs({
    follow: true,
    stdout: true,
    stderr: true,
    tail,
    timestamps: true,
  })) as unknown as NodeJS.ReadableStream;

  const stdout = new PassThrough();
  const stderr = new PassThrough();
  // Containers aren't run with a TTY, so stdout/stderr arrive multiplexed
  // on one stream — dockerode's modem knows how to split them back apart.
  docker.modem.demuxStream(rawStream, stdout, stderr);

  const abort = () => {
    if ("destroy" in rawStream && typeof rawStream.destroy === "function") {
      rawStream.destroy();
    }
  };
  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort, { once: true });

  const queue: LogLine[] = [];
  let resolveNext: (() => void) | null = null;
  let ended = false;

  const push = (stream: LogLine["stream"]) => (chunk: Buffer) => {
    for (const line of chunk.toString("utf8").split("\n")) {
      if (line.length === 0) continue;
      queue.push({ stream, line });
    }
    resolveNext?.();
  };

  stdout.on("data", push("stdout"));
  stderr.on("data", push("stderr"));
  const finish = () => {
    ended = true;
    resolveNext?.();
  };
  rawStream.on("end", finish);
  rawStream.on("close", finish);
  rawStream.on("error", finish);
  signal.addEventListener("abort", finish, { once: true });

  try {
    while (!ended || queue.length > 0) {
      if (queue.length === 0) {
        await new Promise<void>((resolve) => (resolveNext = resolve));
        resolveNext = null;
        continue;
      }
      yield queue.shift()!;
    }
  } finally {
    abort();
  }
}
