export { PolicyBoundary } from "./boundary.ts";
export type { BoundaryDeps } from "./boundary.ts";
export { evaluate } from "./engine.ts";
export { classify } from "./classifier.ts";
export type { Classification } from "./classifier.ts";
export { escalateForProvenance, isTainted } from "./provenance-check.ts";
export { globMatch, globToRegExp } from "./glob.ts";
export * from "./verdict.ts";
export {
  YamlRuleSource,
  StaticRuleSource,
  ruleApplies,
} from "./rules.ts";
export type {
  RuleSource,
  PolicyRule,
  PolicyConfig,
  PermissionMode,
  RuleMatch,
} from "./rules.ts";
export { credentialBlock } from "./hooks/credential-block.ts";
export type { GuardHook } from "./hooks/types.ts";
