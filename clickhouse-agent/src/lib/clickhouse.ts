import { randomUUID } from "node:crypto";

import { createClient, type ResponseJSON } from "@clickhouse/client";

import { prepareReadOnlySql } from "./sqlGuard";

export interface Events {
  id: number;
  event_time: Date;
  event_type: string;
  user_id: number;
  page: string;
  country: string;
  duration_ms: number;
}

const CLICKHOUSE_URL = process.env.CLICKHOUSE_URL ?? "http://localhost:8123";

export const DEFAULT_DATABASE = process.env.CLICKHOUSE_DATABASE ?? "mydb";

export const client = createClient({
  url: CLICKHOUSE_URL,
  username: process.env.CLICKHOUSE_USERNAME ?? "default",
  password: process.env.CLICKHOUSE_PASSWORD ?? "default",
  database: DEFAULT_DATABASE,
});

export const readonlyClient = createClient({
  url: CLICKHOUSE_URL,
  username:
    process.env.CLICKHOUSE_READONLY_USER ??
    process.env.CLICKHOUSE_USERNAME ??
    "default",
  password:
    process.env.CLICKHOUSE_READONLY_PASSWORD ??
    process.env.CLICKHOUSE_PASSWORD ??
    "default",
  database: DEFAULT_DATABASE,
});

const intFromEnv = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (!raw) return fallback;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive number, got '${raw}'.`);
  }

  return Math.floor(parsed);
};

export const SQL_LIMITS = {
  maxRows: intFromEnv("SQL_MAX_ROWS", 500),
  maxExecutionTimeSec: intFromEnv("SQL_MAX_EXECUTION_SECONDS", 15),
  maxRowsToRead: intFromEnv("SQL_MAX_ROWS_TO_READ", 100_000_000),
  maxBytesToRead: intFromEnv("SQL_MAX_BYTES_TO_READ", 2 * 1024 ** 3),
  maxMemoryBytes: intFromEnv("SQL_MAX_MEMORY_BYTES", 2 * 1024 ** 3),
} as const;

export interface ReadOnlySqlResult<T = unknown> {
  sql: string;
  rows: T[];
  rowCount: number;
  truncated: boolean;
  limitApplied: boolean;
  columns: Array<{ name: string; type: string }>;
  queryId: string;
  stats?: { elapsedSec: number; rowsRead: number; bytesRead: number };
}

export const runReadOnlySql = async <T = unknown>(
  sql: string,
  options?: { maxRows?: number },
): Promise<ReadOnlySqlResult<T>> => {
  const maxRows = Math.min(
    options?.maxRows ?? SQL_LIMITS.maxRows,
    SQL_LIMITS.maxRows,
  );

  const prepared = prepareReadOnlySql(sql, maxRows);

  const abort = AbortSignal.timeout(
    (SQL_LIMITS.maxExecutionTimeSec + 5) * 1_000,
  );

  const queryId = randomUUID();

  const resultSet = await readonlyClient.query({
    query: prepared.sql,
    format: "JSON",
    query_id: queryId,
    abort_signal: abort,
    clickhouse_settings: {
      readonly: "2",
      allow_ddl: 0,
      max_execution_time: SQL_LIMITS.maxExecutionTimeSec,
      timeout_overflow_mode: "throw",
      max_result_rows: String(maxRows),
      result_overflow_mode: "break",
      max_rows_to_read: String(SQL_LIMITS.maxRowsToRead),
      read_overflow_mode: "throw",
      max_bytes_to_read: String(SQL_LIMITS.maxBytesToRead),
      max_memory_usage: String(SQL_LIMITS.maxMemoryBytes),
    },
  });

  const response = (await resultSet.json()) as ResponseJSON<T>;
  const rows = (response.data ?? []).slice(0, maxRows);

  return {
    sql: prepared.sql,
    rows,
    rowCount: rows.length,
    truncated: rows.length >= maxRows,
    limitApplied: prepared.limitApplied,
    columns: response.meta ?? [],
    queryId,
    stats: response.statistics && {
      elapsedSec: response.statistics.elapsed,
      rowsRead: response.statistics.rows_read,
      bytesRead: response.statistics.bytes_read,
    },
  };
};

export const createTable = async () => {
  try {
    const res = await client.command({
      query: `
      CREATE TABLE IF NOT EXISTS events (
        id           UInt32,
        event_time   DateTime,
        event_type   String,
        user_id      UInt64,
        page         String,
        country      String,
        duration_ms  UInt32,
      ) ENGINE = MergeTree()
      ORDER BY id
    `,
    });
    return res;
  } catch (error) {
    console.log(error);
    return null;
  }
};

export const queryRows = async <T = unknown>(
  query: string,
  query_params?: Record<string, unknown>,
): Promise<T[]> => {
  const resultSet = await client.query({
    query,
    query_params,
    format: "JSONEachRow",
  });

  return resultSet.json<T>();
};

export const queryTable = async (query: string) => {
  try {
    const resultSet = await client.query({
      query: query,
      format: "JSONEachRow",
    });

    const rows = await resultSet.json();
    return rows;
  } catch (error) {
    console.error(error);
    return null;
  }
};
