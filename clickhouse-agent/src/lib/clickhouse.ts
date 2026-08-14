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

/**
 * Separate connection for SQL that originated from a model or an API caller.
 *
 * Point `CLICKHOUSE_READONLY_USER` at a user that only holds SELECT grants —
 * the statement-level checks in ./sqlGuard are a convenience for the model,
 * the grants are what actually make arbitrary SQL safe. Create it with:
 *
 *   CREATE USER analyst IDENTIFIED BY '...' SETTINGS readonly = 2;
 *   GRANT SELECT ON mydb.* TO analyst;
 *   GRANT SELECT ON system.* TO analyst;   -- for schema introspection
 *
 * `readonly = 2` (rather than 1) is deliberate: it forbids writes and DDL but
 * still lets this client attach the per-query caps below. Under `readonly = 1`
 * ClickHouse rejects the query for trying to change settings at all.
 *
 * If the readonly credentials are unset this falls back to the main client's
 * user, so a dev setup still works — with the guard and the caps but without
 * the grant-level protection.
 */
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

/** Caps applied to every ad-hoc query. All overridable by env. */
export const SQL_LIMITS = {
  /** Rows returned to the caller when they do not ask for fewer. */
  maxRows: intFromEnv("SQL_MAX_ROWS", 500),
  /** Wall-clock budget on the ClickHouse side. */
  maxExecutionTimeSec: intFromEnv("SQL_MAX_EXECUTION_SECONDS", 15),
  /** Rows a query may scan before it is aborted — stops accidental full scans. */
  maxRowsToRead: intFromEnv("SQL_MAX_ROWS_TO_READ", 100_000_000),
  /** Bytes a query may scan before it is aborted. */
  maxBytesToRead: intFromEnv("SQL_MAX_BYTES_TO_READ", 2 * 1024 ** 3),
  /** Memory a single query may use on the server. */
  maxMemoryBytes: intFromEnv("SQL_MAX_MEMORY_BYTES", 2 * 1024 ** 3),
} as const;

export interface ReadOnlySqlResult<T = unknown> {
  /** The statement as executed, i.e. including any LIMIT the guard added. */
  sql: string;
  rows: T[];
  rowCount: number;
  /** True when the row cap cut the result short — there is more data. */
  truncated: boolean;
  /** True when the caller omitted a LIMIT and one was appended. */
  limitApplied: boolean;
  columns: Array<{ name: string; type: string }>;
  /** ClickHouse query id — look it up in system.query_log. */
  queryId: string;
  stats?: { elapsedSec: number; rowsRead: number; bytesRead: number };
}

/**
 * Run caller-supplied SQL under every guardrail: SELECT-only validation, the
 * read-only connection, a forced LIMIT, and server-side execution caps.
 *
 * Throws `SqlGuardError` if the statement is rejected before it is sent, and
 * the underlying ClickHouse error if the server rejects or aborts it.
 */
export const runReadOnlySql = async <T = unknown>(
  sql: string,
  options?: { maxRows?: number },
): Promise<ReadOnlySqlResult<T>> => {
  const maxRows = Math.min(
    options?.maxRows ?? SQL_LIMITS.maxRows,
    SQL_LIMITS.maxRows,
  );

  const prepared = prepareReadOnlySql(sql, maxRows);

  // Belt and braces on the timeout: `max_execution_time` covers query
  // execution, the abort signal covers a connection that never answers.
  const abort = AbortSignal.timeout(
    (SQL_LIMITS.maxExecutionTimeSec + 5) * 1_000,
  );

  // Set the id ourselves so the caller can correlate the query with
  // system.query_log (see the get_query_history tool) even if it was aborted.
  const queryId = randomUUID();

  const resultSet = await readonlyClient.query({
    query: prepared.sql,
    format: "JSON",
    query_id: queryId,
    abort_signal: abort,
    clickhouse_settings: {
      // No writes, no DDL — enforced by the server even if the guard is wrong.
      readonly: "2",
      allow_ddl: 0,
      max_execution_time: SQL_LIMITS.maxExecutionTimeSec,
      timeout_overflow_mode: "throw",
      // Truncate rather than fail when a query returns more than the cap;
      // `truncated` below tells the caller the answer is partial.
      // UInt64 settings go over the wire as strings.
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

/**
 * Run a read query and return typed rows. Unlike `queryTable` this throws on
 * failure so callers (e.g. agent tools) can report why a query failed.
 *
 * Values that come from the model must be passed via `query_params` and
 * referenced as `{name:Type}` in the SQL — never string-interpolated.
 */
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
