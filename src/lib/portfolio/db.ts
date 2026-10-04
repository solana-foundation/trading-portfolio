import { Pool } from "pg";

const STATEMENT_TIMEOUT_MS = 30_000;
const SESSION_OPTIONS = [
  `-c statement_timeout=${STATEMENT_TIMEOUT_MS}`,
  `-c lock_timeout=${STATEMENT_TIMEOUT_MS}`,
  `-c idle_in_transaction_session_timeout=${STATEMENT_TIMEOUT_MS}`,
].join(" ");

let pool: Pool | null = null;

export function dbConfigured(): boolean {
  return Boolean(process.env.DATABASE_URL);
}

export function getPool(): Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 5,
      connectionTimeoutMillis: 5_000,
      query_timeout: STATEMENT_TIMEOUT_MS,
      options: SESSION_OPTIONS,
    });
  }
  return pool;
}
