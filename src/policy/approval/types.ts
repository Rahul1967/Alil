import type { ActionContract, Risk } from "../../core/types.ts";

/** A frozen snapshot of the approved action, re-checked before execution (TOCTOU). */
export interface ExecutionBinding {
  tool: string;
  argsHash: string;
  /** Canonical working directory the grant was approved against, when known. */
  cwd?: string;
  /**
   * Hash of the target file's content at approval time, for write/execute actions with a path.
   * `null` = target did not exist at approval. Recomputed at verify time; a change ⇒ the human
   * approved a different file state than the one about to be executed ⇒ deny. Absent when no
   * workspace root was wired (file-content binding disabled, args/cwd binding still applies).
   */
  targetHash?: string | null;
}

/** Scope of a standing grant minted when the operator chooses to grant, not just allow. */
export interface GrantScope {
  tool: string;
  pathGlob?: string; // optional path constraint; omitted ⇒ any path for this tool
  maxUses: number;
  ttlMs: number;
  task: string;
}

export interface Grant {
  id: string;
  scope: GrantScope;
  expiresAt: number; // epoch ms
  usesRemaining: number;
  approvedAt: number;
}

export interface ApprovalRequest {
  id: string;
  action: ActionContract;
  binding: ExecutionBinding;
  presentedRisk: Risk;
  reason: string;
  /** The tool's own note for the operator (ToolImpl.advise), shown beside the reason. */
  advice?: string;
}

/**
 * Why a request was not approved. `declined` is a human answer; the rest are the harness failing
 * closed with nobody having answered. The ledger attributes each to the right actor.
 */
export type ApprovalOutcome = "declined" | "timeout" | "unreachable";

export interface ApprovalDecision {
  approved: boolean;
  /** If present, mint a standing grant covering future matching actions. */
  scope?: GrantScope;
  reason?: string;
  /** On a non-approval: who/what ended it. Absent ⇒ recorded as `by: "unknown"`, never as the operator. */
  outcome?: ApprovalOutcome;
}

/** The seam: the boundary requests approval; an implementation decides how to ask. */
export interface ApprovalPort {
  request(req: ApprovalRequest): Promise<ApprovalDecision>;
}
