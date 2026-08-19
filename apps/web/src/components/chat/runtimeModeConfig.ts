import type { RuntimeMode } from "@t3tools/contracts";
import { LockIcon, LockOpenIcon, PenLineIcon, SparklesIcon, type LucideIcon } from "lucide-react";

/**
 * Presentation for each permission (runtime) mode, shared by the composer's
 * mode control and settings surfaces that pick a mode, so labels, blurbs, and
 * icons stay identical everywhere.
 */
export const RUNTIME_MODE_CONFIG: Record<
  RuntimeMode,
  { label: string; description: string; icon: LucideIcon }
> = {
  "approval-required": {
    label: "Supervised",
    description: "Ask before commands and file changes.",
    icon: LockIcon,
  },
  "auto-accept-edits": {
    label: "Auto-accept edits",
    description: "Auto-approve edits, ask before other actions.",
    icon: PenLineIcon,
  },
  auto: {
    label: "Auto",
    description: "Supported providers approve routine actions; others still ask.",
    icon: SparklesIcon,
  },
  "full-access": {
    label: "Full access",
    description: "Allow commands and edits without prompts.",
    icon: LockOpenIcon,
  },
};

export const RUNTIME_MODE_OPTIONS = Object.keys(RUNTIME_MODE_CONFIG) as RuntimeMode[];
