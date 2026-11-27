// Minimal D1 stand-in backed by node:sqlite, so tests exercise the real SQL.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// loaded via require: vite strips the "node:" prefix from node:sqlite imports
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
type DatabaseSync = any;

class Stmt {
  constructor(private db: DatabaseSync, private sql: string, private params: unknown[] = []) {}
  bind(...p: unknown[]) {
    return new Stmt(this.db, this.sql, p);
  }
  private args() {
    return this.params.map((v) => (v === undefined ? null : v)) as any[];
  }
  async all<T>() {
    return { results: this.db.prepare(this.sql).all(...this.args()) as T[], success: true };
  }
  async first<T>() {
    return (this.db.prepare(this.sql).get(...this.args()) as T) ?? null;
  }
  async run() {
    this.db.prepare(this.sql).run(...this.args());
    return { success: true };
  }
  runSync() {
    this.db.prepare(this.sql).run(...this.args());
  }
}

export function makeD1() {
  const db = new DatabaseSync(":memory:");
  for (const f of ["0001_init.sql", "0002_costs.sql"]) db.exec(readFileSync(fileURLToPath(new URL(`../migrations/${f}`, import.meta.url) as any), "utf8"));
  const d1 = {
    prepare: (sql: string) => new Stmt(db, sql),
    async batch(stmts: Stmt[]) {
      db.exec("BEGIN");
      try {
        for (const s of stmts) s.runSync();
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
      return [];
    },
  };
  return { d1: d1 as unknown as D1Database, raw: db };
}
