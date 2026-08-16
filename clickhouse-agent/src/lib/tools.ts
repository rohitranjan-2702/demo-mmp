import { tool } from "@openai/agents";
import { z } from "zod";

import {
  DEFAULT_DATABASE,
  queryRows,
  runReadOnlySql,
  SQL_LIMITS,
} from "./clickhouse";

const safely = async <T>(fn: () => Promise<T>) => {
  try {
    return await fn();
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
};

interface TableRow {
  database: string;
  name: string;
  engine: string;
  total_rows: string | null;
  total_bytes: string | null;
  partition_key: string;
  sorting_key: string;
  primary_key: string;
  comment: string;
}

export const listTables = tool({
  name: "list_tables",
  description:
    "List the tables and views available in a ClickHouse database, with their engine, row count and sorting key. Use this first to discover what data exists.",
  parameters: z.object({
    database: z
      .string()
      .nullable()
      .describe(
        `Database to inspect. Pass null for the default database ('${DEFAULT_DATABASE}').`,
      ),
  }),
  execute: async ({ database }) =>
    safely(async () => {
      const db = database ?? DEFAULT_DATABASE;

      const tables = await queryRows<TableRow>(
        `
        SELECT
          database,
          name,
          engine,
          total_rows,
          total_bytes,
          partition_key,
          sorting_key,
          primary_key,
          comment
        FROM system.tables
        WHERE database = {db:String}
        ORDER BY name
        `,
        { db },
      );

      if (tables.length === 0) {
        const databases = await queryRows<{ name: string }>(
          `SELECT name FROM system.databases ORDER BY name`,
        );

        return {
          database: db,
          tableCount: 0,
          tables,
          hint: `No tables in '${db}'. Databases on this server: ${databases
            .map((d) => d.name)
            .join(", ")}.`,
        };
      }

      return { database: db, tableCount: tables.length, tables };
    }),
});

interface ColumnRow {
  name: string;
  type: string;
  default_kind: string;
  default_expression: string;
  comment: string;
  compression_codec: string;
  is_in_primary_key: number;
  is_in_sorting_key: number;
  is_in_partition_key: number;
}

export const describeTable = tool({
  name: "describe_table",
  description:
    "Describe a single ClickHouse table: its columns and types, which columns are part of the primary/sorting/partition key, the table engine, and its CREATE TABLE statement. Use this before writing SQL against a table.",
  parameters: z.object({
    table: z.string().describe("Table name, e.g. 'events'"),
    database: z
      .string()
      .nullable()
      .describe(
        `Database the table lives in. Pass null for the default database ('${DEFAULT_DATABASE}').`,
      ),
    includeSampleRows: z
      .boolean()
      .nullable()
      .describe(
        "Pass true to also return 3 sample rows from the table. Null or false skips them.",
      ),
  }),
  execute: async ({ table, database, includeSampleRows }) =>
    safely(async () => {
      const db = database ?? DEFAULT_DATABASE;

      const columns = await queryRows<ColumnRow>(
        `
        SELECT
          name,
          type,
          default_kind,
          default_expression,
          comment,
          compression_codec,
          is_in_primary_key,
          is_in_sorting_key,
          is_in_partition_key
        FROM system.columns
        WHERE database = {db:String} AND table = {tbl:String}
        ORDER BY position
        `,
        { db, tbl: table },
      );

      if (columns.length === 0) {
        return {
          error: `Table '${db}.${table}' does not exist or has no columns. Call list_tables to see what is available.`,
        };
      }

      const [meta] = await queryRows<{
        engine: string;
        total_rows: string | null;
        sorting_key: string;
        primary_key: string;
        partition_key: string;
        create_table_query: string;
      }>(
        `
        SELECT engine, total_rows, sorting_key, primary_key, partition_key, create_table_query
        FROM system.tables
        WHERE database = {db:String} AND name = {tbl:String}
        `,
        { db, tbl: table },
      );

      const sampleRows = includeSampleRows
        ? await queryRows(
            `SELECT * FROM {db:Identifier}.{tbl:Identifier} LIMIT 3`,
            { db, tbl: table },
          )
        : undefined;

      return { database: db, table, ...meta, columns, sampleRows };
    }),
});

interface QueryLogRow {
  event_time: string;
  query_id: string;
  user: string;
  type: string;
  query: string;
  query_duration_ms: string;
  read_rows: string;
  read_bytes: string;
  result_rows: string;
  memory_usage: string;
  tables: string[];
  exception: string;
}

export const getQueryHistory = tool({
  name: "get_query_history",
  description:
    "Read recently executed queries from ClickHouse's system.query_log, including how long each took, how many rows it read, and any error it raised. Use this to see what has already been asked, to find slow queries, or to debug a query that failed.",
  parameters: z.object({
    hours: z
      .number()
      .int()
      .min(1)
      .max(24 * 30)
      .nullable()
      .describe("Lookback window in hours. Null defaults to 24."),
    limit: z
      .number()
      .int()
      .min(1)
      .max(200)
      .nullable()
      .describe("Maximum number of queries to return. Null defaults to 20."),
    table: z
      .string()
      .nullable()
      .describe(
        "Only return queries that touched this table, e.g. 'events' or 'mydb.events'. Null returns queries against any table.",
      ),
    onlyErrors: z
      .boolean()
      .nullable()
      .describe("Pass true to return only queries that failed."),
    slowestFirst: z
      .boolean()
      .nullable()
      .describe(
        "Pass true to order by duration (slowest first) instead of most recent first.",
      ),
  }),
  execute: async ({ hours, limit, table, onlyErrors, slowestFirst }) =>
    safely(async () => {
      const lookbackHours = hours ?? 24;
      const rowLimit = limit ?? 20;

      const conditions = [
        "event_time >= now() - toIntervalHour({hours:UInt32})",
        "is_initial_query = 1",
        onlyErrors
          ? "type IN ('ExceptionBeforeStart', 'ExceptionWhileProcessing')"
          : "type IN ('QueryFinish', 'ExceptionBeforeStart', 'ExceptionWhileProcessing')",

        "NOT arrayExists(t -> t LIKE 'system.%', tables)",
      ];

      if (table) {
        conditions.push(
          "arrayExists(t -> t = {table:String} OR splitByChar('.', t)[-1] = {table:String}, tables)",
        );
      }

      const queries = await queryRows<QueryLogRow>(
        `
        SELECT
          event_time,
          query_id,
          user,
          type,
          query,
          query_duration_ms,
          read_rows,
          read_bytes,
          result_rows,
          memory_usage,
          tables,
          exception
        FROM system.query_log
        WHERE ${conditions.join(" AND ")}
        ORDER BY ${slowestFirst ? "query_duration_ms DESC" : "event_time DESC"}
        LIMIT {limit:UInt32}
        `,
        { hours: lookbackHours, limit: rowLimit, table: table ?? "" },
      );

      return { lookbackHours, queryCount: queries.length, queries };
    }),
});

export const runSql = tool({
  name: "run_sql",
  description: [
    "Run a read-only SQL SELECT against ClickHouse and get the rows back.",
    "Use this for any question the other tools cannot answer directly: aggregations, filters, time buckets, joins.",
    "Call describe_table first so you use real column names and types.",
    `Only a single SELECT (optionally starting with WITH) is accepted — no INSERT/ALTER/DROP/CREATE, no FORMAT or SETTINGS clause, no file/url/s3/remote table functions, and no multiple statements.`,
    `Results are capped at ${SQL_LIMITS.maxRows} rows and ${SQL_LIMITS.maxExecutionTimeSec}s of execution time; a LIMIT is added automatically if you omit one, so aggregate in SQL rather than pulling raw rows.`,
  ].join(" "),
  parameters: z.object({
    sql: z
      .string()
      .describe(
        'The SELECT statement to run, e.g. "SELECT country, count() AS c FROM events GROUP BY country ORDER BY c DESC". Do not end it with a semicolon.',
      ),
    maxRows: z
      .number()
      .int()
      .min(1)
      .max(SQL_LIMITS.maxRows)
      .nullable()
      .describe(
        `Row cap for this query. Null uses the maximum (${SQL_LIMITS.maxRows}). Values above the maximum are clamped down to it.`,
      ),
  }),
  execute: async ({ sql, maxRows }) =>
    safely(async () => {
      const result = await runReadOnlySql(sql, {
        maxRows: maxRows ?? undefined,
      });

      return {
        sql: result.sql,
        columns: result.columns,
        rowCount: result.rowCount,
        rows: result.rows,
        truncated: result.truncated,
        limitApplied: result.limitApplied,
        note: result.truncated
          ? `Result was cut off at the ${result.rowCount}-row cap — there may be more rows. Aggregate or filter further instead of paging.`
          : undefined,
        stats: result.stats,
      };
    }),
});

export const clickhouseTools = [
  listTables,
  describeTable,
  getQueryHistory,
  runSql,
];
