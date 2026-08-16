export class SqlGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SqlGuardError";
  }
}

const mask = (sql: string): string => {
  const out = sql.split("");
  const blank = (from: number, to: number) => {
    for (let i = from; i < to && i < out.length; i++) {
      if (out[i] !== "\n") out[i] = " ";
    }
  };

  let i = 0;
  while (i < sql.length) {
    const char = sql[i];
    const next = sql[i + 1];

    if (char === "'" || char === '"' || char === "`") {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === "\\") {
          j += 2;
          continue;
        }
        if (sql[j] === char) {
          if (sql[j + 1] === char) {
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      if (j >= sql.length) {
        throw new SqlGuardError(
          `Unterminated ${char === "`" ? "identifier" : "string"} literal starting at character ${i + 1}.`,
        );
      }
      blank(i, j + 1);
      i = j + 1;
      continue;
    }

    if (char === "-" && next === "-") {
      const end = sql.indexOf("\n", i);
      blank(i, end === -1 ? sql.length : end);
      i = end === -1 ? sql.length : end;
      continue;
    }

    if (char === "/" && next === "*") {
      const end = sql.indexOf("*/", i + 2);
      if (end === -1) {
        throw new SqlGuardError(
          "Unterminated block comment (`/*` with no `*/`).",
        );
      }
      blank(i, end + 2);
      i = end + 2;
      continue;
    }

    i++;
  }

  return out.join("");
};

interface ForbiddenPattern {
  pattern: RegExp;
  reason: string;
}

const FORBIDDEN: ForbiddenPattern[] = [
  {
    pattern:
      /\b(insert\s+into|alter\s+(table|user|database)|drop\s+(table|database|view|user|dictionary|column|function|policy)|create\s+(table|database|view|user|dictionary|function|policy|temporary)|attach\s+(table|database|part|partition)|detach\s+(table|database|part|partition)|truncate\s+table|rename\s+table|replace\s+table|exchange\s+tables|optimize\s+table|grant\s+|revoke\s+|kill\s+(query|mutation)|system\s+(flush|reload|drop|stop|start|sync|restart|kill|shutdown))\b/i,
    reason:
      "only read-only SELECT statements are allowed — no DDL, DML or admin commands",
  },
  {
    pattern:
      /\b(file|url|urlCluster|s3|s3Cluster|remote|remoteSecure|cluster|clusterAllReplicas|mysql|postgresql|mongodb|redis|sqlite|jdbc|odbc|hdfs|hdfsCluster|azureBlobStorage|deltaLake|iceberg|hudi|executable|input)\s*\(/i,
    reason:
      "table functions that read from files, URLs or external systems are not allowed — query tables in ClickHouse instead",
  },
  {
    pattern: /\binto\s+outfile\b/i,
    reason: "`INTO OUTFILE` writes to the server filesystem",
  },
  {
    pattern: /\bformat\b(?!\s*\()/i,
    reason:
      "a `FORMAT` clause is not allowed — the result format is fixed by the caller",
  },
  {
    pattern: /\bsettings\s+[a-z_][a-z0-9_]*\s*=/i,
    reason:
      "a `SETTINGS` clause is not allowed — it could override the execution-time and row limits",
  },
];

export interface PreparedSql {
  sql: string;
  limitApplied: boolean;
}

export const prepareReadOnlySql = (
  input: string,
  maxRows: number,
): PreparedSql => {
  const trimmed = input.trim();

  if (trimmed.length === 0) {
    throw new SqlGuardError("Empty query.");
  }

  const masked = mask(trimmed);

  const firstSemicolon = masked.indexOf(";");
  if (firstSemicolon !== -1 && masked.slice(firstSemicolon + 1).trim() !== "") {
    throw new SqlGuardError(
      "Only one statement per call — remove everything after the first `;`.",
    );
  }

  const end = firstSemicolon === -1 ? trimmed.length : firstSemicolon;
  const statement = trimmed.slice(0, end).trimEnd();
  const maskedStatement = masked.slice(0, end).trimEnd();

  if (!/^\s*(select|with)\b/i.test(maskedStatement)) {
    const firstWord = maskedStatement.trim().split(/\s+/)[0] ?? "";
    throw new SqlGuardError(
      `Only SELECT queries are allowed, but this one starts with '${firstWord}'. Rewrite it as a SELECT (a leading WITH ... SELECT is fine).`,
    );
  }

  if (!/\bselect\b/i.test(maskedStatement)) {
    throw new SqlGuardError("The statement contains no SELECT.");
  }

  for (const { pattern, reason } of FORBIDDEN) {
    const match = maskedStatement.match(pattern);
    if (match) {
      throw new SqlGuardError(
        `Query rejected at '${match[0].trim()}': ${reason}.`,
      );
    }
  }

  if (hasTopLevelLimit(maskedStatement)) {
    return { sql: statement, limitApplied: false };
  }

  return { sql: `${statement}\nLIMIT ${maxRows}`, limitApplied: true };
};

const hasTopLevelLimit = (maskedStatement: string): boolean => {
  let depth = 0;

  for (let i = 0; i < maskedStatement.length; i++) {
    const char = maskedStatement[i];

    if (char === "(") depth++;
    else if (char === ")") depth = Math.max(0, depth - 1);
    else if (depth === 0 && (char === "l" || char === "L")) {
      const word = maskedStatement.slice(i, i + 5);
      const before = maskedStatement[i - 1] ?? " ";
      const after = maskedStatement[i + 5] ?? " ";
      if (
        word.toLowerCase() === "limit" &&
        !/[\w$]/.test(before) &&
        !/[\w$]/.test(after)
      ) {
        return true;
      }
    }
  }

  return false;
};
