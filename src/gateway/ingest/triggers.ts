import type { IncomingEvent } from "../../memory/types.ts";
import type { WorldModel } from "../../world/types.ts";
import type { TriggerRule } from "./types.ts";

/** Build a trigger from a predicate + an instruction renderer. */
export function trigger(
  name: string,
  predicate: (event: IncomingEvent, world: WorldModel | null) => boolean,
  render: (event: IncomingEvent) => string,
): TriggerRule {
  return {
    name,
    evaluate(event, world) {
      return predicate(event, world) ? render(event) : null;
    },
  };
}

/** Fire when an event's text/subject/from contains any of `keywords` (case-insensitive). */
export function keywordTrigger(name: string, keywords: string[], render?: (e: IncomingEvent) => string): TriggerRule {
  const needles = keywords.map((k) => k.toLowerCase());
  return trigger(
    name,
    (e) => {
      const hay = `${e.from ?? ""} ${e.subject ?? ""} ${e.text ?? ""}`.toLowerCase();
      return needles.some((n) => hay.includes(n));
    },
    render ?? ((e) => defaultInstruction(name, e)),
  );
}

/**
 * Fire when a tracked numeric system state crosses a threshold. Compares `event`'s numeric text
 * (or a provided extractor) against the value currently in the world-model under `key`.
 */
export function thresholdTrigger(
  name: string,
  key: string,
  opts: { below?: number; above?: number; value?: (e: IncomingEvent) => number | null },
): TriggerRule {
  return {
    name,
    evaluate(event, world) {
      const v = opts.value ? opts.value(event) : numeric(event.text);
      if (v === null) return null;
      if (opts.below !== undefined && v < opts.below) return `A tracked value crossed below ${opts.below}: ${key} is now ${v}. Assess and, if warranted, tell the user.`;
      if (opts.above !== undefined && v > opts.above) return `A tracked value crossed above ${opts.above}: ${key} is now ${v}. Assess and, if warranted, tell the user.`;
      void world;
      return null;
    },
  };
}

function numeric(text?: string): number | null {
  if (!text) return null;
  const m = text.match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : null;
}

export function defaultInstruction(rule: string, e: IncomingEvent): string {
  const src = `${e.channel}${e.type ? `/${e.type}` : ""}`;
  const body = e.subject ?? e.text ?? "(no content)";
  return [
    `An ambient event matched the "${rule}" watch.`,
    `Source: ${src}${e.from ? `, from ${e.from}` : ""}.`,
    `Content (untrusted): ${body}`,
    `Decide whether this needs the user's attention or an action; if so, do it (subject to approval). If not, do nothing.`,
  ].join("\n");
}
