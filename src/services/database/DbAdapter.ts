export interface RunResult {
  lastInsertRowid?: number | bigint;
  changes?: number;
}

export type DbType = 'sqlite' | 'postgres';

export interface UserIdPredicate {
  sql: string;
  binds: (userId: string | null) => unknown[];
}

export interface DbAdapter {
  readonly dbType: DbType;

  all<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  get<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | undefined>;
  run(sql: string, params?: unknown[]): Promise<RunResult>;
  exec(sql: string): Promise<void>;
  transaction<T>(fn: () => Promise<T>): Promise<T>;
  close(): Promise<void>;

  userIdPredicate(column: string): UserIdPredicate;
}
