/**
 * Minimal ambient types for the native deps we use. Covers only the surface Alil touches.
 * Drop this file if `@types/better-sqlite3` is ever added. `sqlite-vec` ships its own types.
 */
declare module "better-sqlite3" {
  type BindParam = number | bigint | string | Buffer | Uint8Array | null;

  interface RunResult {
    changes: number;
    lastInsertRowid: number | bigint;
  }

  interface Statement {
    run(...params: BindParam[]): RunResult;
    get(...params: BindParam[]): unknown;
    all(...params: BindParam[]): unknown[];
    iterate(...params: BindParam[]): IterableIterator<unknown>;
  }

  /** A wrapped transaction; the variants pick BEGIN DEFERRED / IMMEDIATE / EXCLUSIVE. */
  interface Transaction<A extends unknown[], R> {
    (...args: A): R;
    deferred(...args: A): R;
    immediate(...args: A): R;
    exclusive(...args: A): R;
  }

  interface BetterSqlite3Database {
    prepare(source: string): Statement;
    exec(source: string): BetterSqlite3Database;
    pragma(source: string, options?: { simple?: boolean }): unknown;
    loadExtension(file: string, entrypoint?: string): void;
    transaction<A extends unknown[], R>(fn: (...args: A) => R): Transaction<A, R>;
    close(): void;
    readonly open: boolean;
    readonly name: string;
  }

  interface Options {
    readonly?: boolean;
    fileMustExist?: boolean;
    timeout?: number;
  }

  interface DatabaseConstructor {
    new (filename: string, options?: Options): BetterSqlite3Database;
    (filename: string, options?: Options): BetterSqlite3Database;
  }

  const Database: DatabaseConstructor;
  export default Database;
  export type { BetterSqlite3Database as Database, Statement, RunResult, BindParam };
}
