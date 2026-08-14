import { connect } from "node:net";

/** One infra service the sidebar reports on. */
export type ServiceCheck = {
  name: string;
  /** "http" GETs `path` and treats any response as up; "tcp" just dials the socket. */
  kind: "http" | "tcp";
  url: string;
  path?: string;
};

const TIMEOUT_MS = 3_000;

// Every URL here is read from an env var with a localhost fallback — never
// hardcoded — so this list tracks whatever docker-compose.yml wires up
// (in-network hostnames in containers, localhost for `next dev` on the host).
export const SERVICES: ServiceCheck[] = [
  {
    name: "kafka",
    kind: "tcp",
    url: process.env.KAFKA_BROKER_URL ?? "localhost:9092",
  },
  {
    name: "kafka-ui",
    kind: "http",
    url: process.env.KAFKA_UI_URL ?? "http://localhost:8080",
    path: "/",
  },
  {
    name: "clickhouse",
    kind: "http",
    url: process.env.CLICKHOUSE_URL ?? "http://localhost:8123",
    path: "/ping",
  },
  {
    name: "producer",
    kind: "http",
    url: process.env.PRODUCER_URL ?? "http://localhost:8001",
    path: "/",
  },
  {
    name: "consumer",
    kind: "http",
    url: process.env.CONSUMER_URL ?? "http://localhost:8002",
    path: "/",
  },
  {
    name: "clickhouse-agent",
    kind: "http",
    url: process.env.SMART_ANALYSIS_URL ?? "http://localhost:3030",
    path: "/",
  },
];

// The full set of this project's docker-compose container names — every
// `SERVICES` entry plus web-app itself, which doesn't health-check itself.
// Shared with lib/docker.ts as the single source of truth for which
// containers the /logs page is allowed to look at.
export const PROJECT_CONTAINERS: string[] = [
  ...SERVICES.map((service) => service.name),
  "web-app",
];

export type HealthResult = {
  name: string;
  status: "healthy" | "unhealthy";
  latencyMs: number;
  error?: string;
};

function checkHttp(service: ServiceCheck): Promise<HealthResult> {
  const started = performance.now();
  return fetch(new URL(service.path ?? "/", service.url), {
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
    .then((res) => ({
      name: service.name,
      // Reachability is the signal, not a specific status code — a 404 on
      // a root route still means the process is up and accepting requests.
      status: res.ok || (res.status >= 200 && res.status < 500)
        ? ("healthy" as const)
        : ("unhealthy" as const),
      latencyMs: Math.round(performance.now() - started),
      ...(res.ok ? {} : { error: `HTTP ${res.status}` }),
    }))
    .catch((err) => ({
      name: service.name,
      status: "unhealthy" as const,
      latencyMs: Math.round(performance.now() - started),
      error: err instanceof Error ? err.message : String(err),
    }));
}

function checkTcp(service: ServiceCheck): Promise<HealthResult> {
  const started = performance.now();
  const [host, portStr] = service.url.split(":");
  const port = Number(portStr);

  return new Promise((resolve) => {
    const socket = connect({ host, port, timeout: TIMEOUT_MS });

    const finish = (status: "healthy" | "unhealthy", error?: string) => {
      socket.destroy();
      resolve({
        name: service.name,
        status,
        latencyMs: Math.round(performance.now() - started),
        ...(error ? { error } : {}),
      });
    };

    socket.once("connect", () => finish("healthy"));
    socket.once("timeout", () => finish("unhealthy", "timed out"));
    socket.once("error", (err) => finish("unhealthy", err.message));
  });
}

export function checkAllServices(): Promise<HealthResult[]> {
  return Promise.all(
    SERVICES.map((service) =>
      service.kind === "tcp" ? checkTcp(service) : checkHttp(service),
    ),
  );
}
