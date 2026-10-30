import type { BrainObserver } from "../runtime/types.ts";
import type { Telemetry } from "./telemetry.ts";

/**
 * Adapts the brain's observer hooks to telemetry events. Records sizes, enums and timings only;
 * the text the model wrote and the data a tool returned stay out unless content capture is on.
 * Compose it beside a channel's own observer (see composeObservers).
 */
export function telemetryObserver(t: Telemetry): BrainObserver {
  return {
    onModelCall: (e) => {
      const { error, ...fields } = e;
      t.emit("model.call", fields, error ? { error } : undefined);
    },
    onToolResult: (e) => {
      t.emit(
        "tool.call",
        {
          tool: e.tool,
          outcome: e.outcome,
          ...(e.callId ? { callId: e.callId } : {}),
          ...(e.durationMs !== undefined ? { durationMs: e.durationMs } : {}),
          ...(e.approvalWaitMs !== undefined ? { approvalWaitMs: e.approvalWaitMs } : {}),
          ...(e.tainted ? { tainted: true } : {}),
          resultChars: sizeOf(e.data),
        },
        { summary: e.summary },
      );
    },
    onHalt: (e) => t.emit("turn.halt", { haltKind: e.kind }, { reason: e.reason }),
  };
}

function sizeOf(data: unknown): number {
  if (data === undefined) return 0;
  if (typeof data === "string") return data.length;
  try { return JSON.stringify(data).length; } catch { return 0; }
}
