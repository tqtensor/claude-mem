import { Database } from 'bun:sqlite';
import type { DbAdapter, DbType } from './DbAdapter.js';
import { SqliteAdapter } from './SqliteAdapter.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';

export interface AdapterFactoryOptions {
  sqliteDb?: Database;
}

export class AdapterFactory {
  static getDbType(): DbType {
    const v = SettingsDefaultsManager.get('CLAUDE_MEM_DB_TYPE');
    return v === 'postgres' ? 'postgres' : 'sqlite';
  }

  static async create(options: AdapterFactoryOptions = {}): Promise<DbAdapter> {
    const dbType = this.getDbType();

    if (dbType === 'postgres') {
      const url = SettingsDefaultsManager.get('CLAUDE_MEM_DATABASE_URL');
      if (!url) {
        throw new Error('CLAUDE_MEM_DB_TYPE=postgres but CLAUDE_MEM_DATABASE_URL is empty');
      }
      const { PostgresAdapter } = await import('./PostgresAdapter.js');
      return new PostgresAdapter(url);
    }

    if (!options.sqliteDb) {
      throw new Error('SqliteAdapter requires an existing bun:sqlite Database instance');
    }
    return new SqliteAdapter(options.sqliteDb);
  }
}
