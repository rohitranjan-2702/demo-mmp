-- Runs once on first container start (mounted at /docker-entrypoint-initdb.d).
-- Creates the table `consumer` writes to and `clickhouse-agent` queries
-- from, so the stack works end-to-end without a manual migration step.
--
-- NOTE: the clickhouse-server entrypoint creates the CLICKHOUSE_DB database
-- but runs *.sql init scripts via `clickhouse-client` WITHOUT `--database`,
-- so an unqualified table name here lands in `default`, not CLICKHOUSE_DB.
-- Qualify it explicitly to make sure it lands in mydb regardless.
CREATE TABLE IF NOT EXISTS mydb.events (
    id           UInt32,
    event_time   DateTime,
    event_type   String,
    user_id      UInt64,
    page         String,
    country      String,
    duration_ms  UInt32
) ENGINE = MergeTree()
ORDER BY id;
