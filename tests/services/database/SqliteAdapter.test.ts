import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { SqliteAdapter } from '../../../src/services/database/SqliteAdapter.js';

describe('SqliteAdapter', () => {
  let db: Database;
  let adapter: SqliteAdapter;

  beforeEach(() => {
    db = new Database(':memory:');
    adapter = new SqliteAdapter(db);
  });

  afterEach(async () => {
    await adapter.close();
  });

  it('all/get/run round-trip', async () => {
    await adapter.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)');
    await adapter.run('INSERT INTO t (name) VALUES (?)', ['alice']);
    await adapter.run('INSERT INTO t (name) VALUES (?)', ['bob']);

    const rows = await adapter.all<{ id: number; name: string }>('SELECT * FROM t ORDER BY id');
    expect(rows).toHaveLength(2);
    expect(rows[0].name).toBe('alice');

    const one = await adapter.get<{ name: string }>('SELECT name FROM t WHERE id = ?', [1]);
    expect(one?.name).toBe('alice');
  });

  it('exec runs multi-statement DDL', async () => {
    await adapter.exec(`
      CREATE TABLE a (x INTEGER);
      CREATE TABLE b (y INTEGER);
      INSERT INTO a VALUES (1);
    `);
    const tables = await adapter.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
    );
    expect(tables.map((t) => t.name)).toEqual(['a', 'b']);
  });

  it('transaction commits when callback resolves', async () => {
    await adapter.exec('CREATE TABLE t (n INTEGER)');
    await adapter.transaction(async () => {
      await adapter.run('INSERT INTO t VALUES (?)', [1]);
      await adapter.run('INSERT INTO t VALUES (?)', [2]);
    });
    const rows = await adapter.all('SELECT * FROM t');
    expect(rows).toHaveLength(2);
  });

  it('transaction rolls back when callback throws', async () => {
    await adapter.exec('CREATE TABLE t (n INTEGER)');
    await expect(
      adapter.transaction(async () => {
        await adapter.run('INSERT INTO t VALUES (?)', [1]);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const rows = await adapter.all('SELECT * FROM t');
    expect(rows).toHaveLength(0);
  });

  it('serializes concurrent transactions via internal mutex', async () => {
    await adapter.exec('CREATE TABLE t (n INTEGER)');

    const order: string[] = [];
    const tx1 = adapter.transaction(async () => {
      order.push('tx1-start');
      await new Promise((r) => setTimeout(r, 30));
      await adapter.run('INSERT INTO t VALUES (?)', [1]);
      order.push('tx1-end');
    });
    const tx2 = adapter.transaction(async () => {
      order.push('tx2-start');
      await adapter.run('INSERT INTO t VALUES (?)', [2]);
      order.push('tx2-end');
    });
    await Promise.all([tx1, tx2]);

    expect(order).toEqual(['tx1-start', 'tx1-end', 'tx2-start', 'tx2-end']);
    const rows = await adapter.all<{ n: number }>('SELECT n FROM t ORDER BY n');
    expect(rows.map((r) => r.n)).toEqual([1, 2]);
  });

  it('userIdPredicate matches null/null and value/value', async () => {
    await adapter.exec('CREATE TABLE u (user_id TEXT, n INTEGER)');
    await adapter.run('INSERT INTO u VALUES (?, ?)', [null, 1]);
    await adapter.run('INSERT INTO u VALUES (?, ?)', ['alice', 2]);
    await adapter.run('INSERT INTO u VALUES (?, ?)', ['bob', 3]);

    const pred = adapter.userIdPredicate('user_id');

    const nullRows = await adapter.all<{ n: number }>(
      `SELECT n FROM u WHERE ${pred.sql}`,
      pred.binds(null),
    );
    expect(nullRows.map((r) => r.n)).toEqual([1]);

    const aliceRows = await adapter.all<{ n: number }>(
      `SELECT n FROM u WHERE ${pred.sql}`,
      pred.binds('alice'),
    );
    expect(aliceRows.map((r) => r.n)).toEqual([2]);
  });
});
