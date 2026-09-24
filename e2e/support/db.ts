import pg from "pg";
import { E2E_DB_URL } from "./env";

export type Db = pg.Pool;

export function createPool(): Db {
  return new pg.Pool({
    connectionString: E2E_DB_URL,
    max: 4,
    // Read DATE columns as plain "YYYY-MM-DD" strings, exactly as the app's
    // own api/src/db.ts does — pg's default turns them into JS Dates at UTC
    // midnight, which makes date assertions timezone-dependent.
    types: {
      getTypeParser: ((oid: number, format?: "text" | "binary") =>
        oid === 1082 ? (value: string) => value : pg.types.getTypeParser(oid, format as "text")) as typeof pg.types.getTypeParser,
    },
  });
}
