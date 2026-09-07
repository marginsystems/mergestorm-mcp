import { setStackPolicy, type Config, type StackPolicyPatch } from "mergestorm/client";
import type { ToolPayload } from "./types.js";

/**
 * `stack_set` input. Every key is optional but at least one must be present.
 * `auto_land` is boolean; `auto_review` / `auto_patch` are tri-state where
 * `null` clears the per-stack override back to the account setting.
 */
export type StackSetInput = {
  auto_land?: boolean;
  auto_review?: boolean | null;
  auto_patch?: boolean | null;
};

function triWord(value: boolean | null): string {
  return value === null ? "default" : value ? "on" : "off";
}

export function stackSetPatch(input: StackSetInput): StackPolicyPatch {
  const patch: StackPolicyPatch = {};
  if (typeof input.auto_land === "boolean") patch.autoEnqueueWhenReady = input.auto_land;
  if (input.auto_review !== undefined) patch.autoReviewOverride = input.auto_review;
  if (input.auto_patch !== undefined) patch.autoPatchOverride = input.auto_patch;
  return patch;
}

export async function stackSet(
  stackId: string,
  input: StackSetInput,
  cfg?: Config,
): Promise<ToolPayload> {
  const patch = stackSetPatch(input);
  if (Object.keys(patch).length === 0) {
    return {
      summary: "stack_set needs at least one of auto_land, auto_review, auto_patch",
      isError: true,
      data: {
        error: {
          code: "invalid_input",
          message: "Pass at least one of auto_land, auto_review, auto_patch.",
          stack_id: stackId,
        },
      },
    };
  }
  const result = await setStackPolicy(stackId, patch, cfg);
  const parts: string[] = [];
  if (typeof input.auto_land === "boolean") {
    parts.push(`Auto land ${input.auto_land ? "on" : "off"}`);
  }
  if (input.auto_review !== undefined) {
    parts.push(`auto-review ${triWord(input.auto_review)}`);
  }
  if (input.auto_patch !== undefined) {
    parts.push(`auto-patch ${triWord(input.auto_patch)}`);
  }
  return {
    summary: `${parts.join(", ")} for stack ${stackId}`,
    data: {
      stack_id: stackId,
      ...(typeof input.auto_land === "boolean" ? { auto_land: input.auto_land } : {}),
      ...(input.auto_review !== undefined ? { auto_review: input.auto_review } : {}),
      ...(input.auto_patch !== undefined ? { auto_patch: input.auto_patch } : {}),
      result,
    },
  };
}
