import type { ActionContract } from "../../core/types.ts";
import type { Verdict } from "../verdict.ts";
import { deny } from "../verdict.ts";
import { globMatch } from "../glob.ts";
import type { GuardHook } from "./types.ts";

const CREDENTIAL_GLOBS = [
  "**/.env",
  "**/.env.*",
  "**/.aws/**",
  "**/.ssh/**",
  "**/.gnupg/**",
  "**/*credential*",
  "**/*secret*",
  "**/id_rsa",
  "**/id_ed25519",
  "**/*.pem",
  "**/*.key",
];

/**
 * Hard-blocks any action touching a credential-shaped path. Code-enforced and immune to
 * config/mode loosening — this is the "must run on every call" safety net (BEST_PRACTICES §5).
 */
export const credentialBlock: GuardHook = {
  name: "credential-block",
  check(action: ActionContract): Verdict | null {
    const path = action.args["path"];
    if (typeof path !== "string") return null;
    for (const g of CREDENTIAL_GLOBS) {
      if (globMatch(g, path)) {
        return deny("hook:credential-block", `path matches protected pattern "${g}"`);
      }
    }
    return null;
  },
};
