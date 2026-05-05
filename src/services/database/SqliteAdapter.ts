import { Database } from 'bun:sqlite';
import type { DbAdapter, DbType, RunResult, UserIdPredicate } from './DbAdapter.js';

export class SqliteAdapter implements DbAdapter {
  readonly dbType: DbType = 'sqlite';
  private txMutex: Promise<unknown> = Promise.resolve();

  constructor(public readonly db: Database) {}

  async all<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    return this.db.query(sql).all(...(params as any[])) as T[];
  }

  async get<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T | undefined> {
    return this.db.query(sql).get(...(params as any[])) as T | undefined;
  }

  async run(sql: string, params: unknown[] = []): Promise<RunResult> {
    const stmt = this.db.query(sql);
    const result = stmt.run(...(params as any[]));
    return {
      lastInsertRowid: result.lastInsertRowid,
      changes: result.changes,
    };
  }

  async exec(sql: string): Promise<void> {
    this.db.run(sql);
  }

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.txMutex;
    let release!: (v?: unknown) => void;
    this.txMutex = new Promise((r) => (release = r));
    try {
      await prev;
      this.db.run('BEGIN');
      try {
        const result = await fn();
        this.db.run('COMMIT');
        return result;
      } catch (e) {
        try {
          this.db.run('ROLLBACK');
        } catch {
          // ignore rollback failure; original error is more important
        }
        throw e;
      }
    } finally {
      release();
    }
  }

  async close(): Promise<void> {
    this.db.close();
  }

  userIdPredicate(column: string): UserIdPredicate {
    return {
      sql: `(${column} = ? OR (${column} IS NULL AND ? IS NULL))`,
      binds: (userId) => [userId, userId],
    };
  }
}
