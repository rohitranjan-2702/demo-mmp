import { createClient, type ClickHouseClient } from "@clickhouse/client";

export interface Events {
  id: number;
  event_time: Date;
  event_type: string;
  user_id: number;
  page: string;
  country: string;
  duration_ms: number;
}

// ClickHouse's `DateTime` column (default date_time_input_format=basic)
// only accepts "YYYY-MM-DD HH:MM:SS". JS's Date.toJSON() (used implicitly
// when JSON-serializing rows for JSONEachRow) produces ISO 8601 with
// milliseconds and a trailing 'Z' (e.g. "2026-08-14T09:34:38.222Z"), which
// ClickHouse can't parse — so raw Date values must be formatted before insert.
const formatDateTime = (date: Date): string =>
  date.toISOString().slice(0, 19).replace("T", " ");

export const client = createClient({
  url: process.env.CLICKHOUSE_URL,
  username: process.env.CLICKHOUSE_USERNAME,
  password: process.env.CLICKHOUSE_PASSWORD,
  database: process.env.CLICKHOUSE_DATABASE,
});

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

export class BatchBuffer {
  private client: ClickHouseClient;
  private table: string;
  private maxSize: number;
  private maxWaitMs: number;
  private buffer: Array<Events>;
  private timer: ReturnType<typeof setTimeout> | null;

  constructor(
    client: ClickHouseClient,
    table: string,
    maxSize = 100,
    maxWaitMs = 3000,
  ) {
    this.client = client;
    this.table = table;
    this.maxSize = maxSize;
    this.maxWaitMs = maxWaitMs;
    this.buffer = [];
    this.timer = null;
  }

  add(row: Events) {
    this.buffer.push(row);

    // flush on size, otherwise start the age timer for this batch
    if (this.buffer.length >= this.maxSize) {
      void this.flush();
    } else if (!this.timer) {
      this.timer = setTimeout(() => void this.flush(), this.maxWaitMs);
    }
  }

  async flush() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.buffer.length === 0) return;

    const rows = this.buffer;
    this.buffer = [];

    try {
      await this.client.insert({
        table: this.table,
        values: rows.map((row) => ({
          ...row,
          event_time: formatDateTime(row.event_time),
        })),
        format: "JSONEachRow",
      });
      console.log(rows.length, "rows inserted to clickhouse");
    } catch (error) {
      console.error("clickhouse insert failed, requeueing rows", error);
      // put them back at the front so ordering is preserved on retry
      this.buffer.unshift(...rows);
      if (!this.timer) {
        this.timer = setTimeout(() => void this.flush(), this.maxWaitMs);
      }
    }
  }
}
