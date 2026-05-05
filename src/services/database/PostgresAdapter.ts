import { SQL } from 'bun';
import type { DbAdapter, DbType, RunResult, UserIdPredicate } from './DbAdapter.js';
import { convertPlaceholders } from './convertPlaceholders.js';

export class PostgresAdapter implements DbAdapter {
  readonly dbType: DbType = 'postgres';
  private sql: SQL;

  constructor(connectionString: string) {
    this.sql = new SQL(connectionString);
  }

  async all<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    const converted = convertPlaceholders(sql);
    const result = await this.sql.unsafe(converted, params as any[]);
    return result as unknown as T[];
  }

  async get<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T | undefined> {
    const rows = await this.all<T>(sql, params);
    return rows[0];
  }

  async run(sql: string, params: unknown[] = []): Promise<RunResult> {
    const converted = convertPlaceholders(sql);
    const result: any = await this.sql.unsafe(converted, params as any[]);
    return {
      changes: typeof result?.count === 'number' ? result.count : (Array.isArray(result) ? result.length : undefined),
    };
  }

  async exec(sql: string): Promise<void> {
    await this.sql.unsafe(sql);
  }

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    return this.sql.begin(async () => {
      return await fn();
    }) as Promise<T>;
  }

  async close(): Promise<void> {
    await this.sql.end();
  }

  userIdPredicate(column: string): UserIdPredicate {
    return {
      sql: `${column} IS NOT DISTINCT FROM ?`,
      binds: (userId) => [userId],
    };
  }
}
