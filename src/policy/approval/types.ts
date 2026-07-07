import type { ActionContract, Risk } from "../../core/types.ts";

/** A frozen snapshot of the approved action, re-checked before execution (TOCTOU). */
export interface ExecutionBinding {
  tool: string;
  argsHash: string;
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
}

export interface ApprovalDecision {
  approved: boolean;
  /** If present, mint a standing grant covering future matching actions. */
  scope?: GrantScope;
  reason?: string;
}

/** The seam: the boundary requests approval; an implementation decides how to ask. */
export interface ApprovalPort {
  request(req: ApprovalRequest): Promise<ApprovalDecision>;
}
