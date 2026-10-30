import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";

/**
 * The turn context: which turn the current code runs on behalf of. Set once at the top of a turn;
 * every event emitted anywhere below it — loop, boundary, MCP registry, recall — picks it up
 * without each component having to accept and forward an id. Concurrent turns stay separate
 * because the context follows each async chain.
 */
export interface TurnContext {
  turnId: string;
  channel?: string;
  episodeId?: string;
  label?: string;
  lens?: string;
}

const storage = new AsyncLocalStorage<TurnContext>();

/** A sortable, collision-resistant turn id: `t_<base36 ms>_<6 hex>`. */
export function newTurnId(now: number = Date.now()): string {
  return `t_${now.toString(36)}_${randomBytes(3).toString("hex")}`;
}

export function withTurn<T>(ctx: TurnContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

export function currentTurn(): TurnContext | undefined {
  return storage.getStore();
}

/** Fill in a field learned after the turn started (e.g. the episode id). */
export function annotateTurn(fields: Partial<Omit<TurnContext, "turnId">>): void {
  const ctx = storage.getStore();
  if (ctx) Object.assign(ctx, fields);
}
