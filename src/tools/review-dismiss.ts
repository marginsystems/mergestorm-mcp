import {
  dismissPrFindings,
  stackWatchObligation,
  type Config,
  type PrFindingDismissInput,
  type PrFindingDismissResult,
} from "mergestorm/client";
import { withWatchText } from "./stack-wait.js";
import type { ToolPayload } from "./types.js";

export type ReviewDismissInput = {
  owner: string;
  repo: string;
  pr_number: number;
  head_sha: string;
  review_id: number;
  finding_ids?: string[];
  scope?: "findings" | "review";
  reason?: string;
  evidence_url?: string;
  preview?: boolean;
};

function findingText(finding: { finding_id: string; path: string | null; title: string }): string {
  return `${finding.finding_id} (${finding.path ?? "review body"}: ${finding.title})`;
}

export function reviewDismissSummary(result: PrFindingDismissResult): string {
  const pr = `${result.owner}/${result.repo}#${result.pr_number}`;
  const kind = result.review_kind === "seam" ? "seam review" : "Vortex review";
  const head = `${kind} ${result.review_id} at ${result.head_sha.slice(0, 7)}`;
  const lines: string[] = [];
  if (result.status === "preview") {
    lines.push(`${pr} ${head}: ${result.remaining.length} open finding(s). Nothing was written.`);
    for (const finding of result.remaining) lines.push(`- ${findingText(finding)}`);
  } else {
    lines.push(
      `${pr} ${head}: dismissed ${result.dismissed.length}, already dismissed ${result.already_dismissed.length}, still open ${result.remaining.length}.`,
    );
    for (const finding of result.remaining) lines.push(`- open: ${findingText(finding)}`);
  }
  const seam = result.gate.seam;
  if (seam) {
    lines.push(
      seam.cleared
        ? "Seam gate cleared at this head. CI, other reviews and Auto land policy are unchanged."
        : seam.blocking
          ? `Seam gate still blocking (seam_state=${seam.state}).`
          : `Seam gate not blocking (seam_state=${seam.state}).`,
    );
  }
  const vortex = result.gate.vortex;
  if (vortex?.cleared) {
    lines.push("Vortex gate cleared at this head: every Vortex Blocker (error finding) at this head is dismissed. CI and Auto land policy are unchanged.");
  } else if (vortex?.message && vortex.reason !== "review_findings_open") {
    lines.push(`Vortex gate not cleared: ${vortex.message}`);
  }
  return lines.join("\n");
}

export async function reviewDismiss(input: ReviewDismissInput, cfg?: Config): Promise<ToolPayload> {
  const request: PrFindingDismissInput = {
    owner: input.owner,
    repo: input.repo,
    prNumber: input.pr_number,
    headSha: input.head_sha,
    reviewId: input.review_id,
    ...(input.scope ? { scope: input.scope } : {}),
    ...(input.finding_ids ? { findingIds: input.finding_ids } : {}),
    ...(input.reason !== undefined ? { reason: input.reason } : {}),
    ...(input.evidence_url ? { evidenceUrl: input.evidence_url } : {}),
    ...(input.preview ? { preview: true } : {}),
  };
  const outcome = await dismissPrFindings(request, cfg);
  if (!outcome.ok) {
    return {
      summary: `review_dismiss refused (${outcome.error}): ${outcome.message}`,
      isError: true,
      data: { error: { code: outcome.error, message: outcome.message, status: outcome.status } },
    };
  }
  const result = outcome.result;
  const summary = reviewDismissSummary(result);
  if (!result.stack_id) return { summary, data: { ...result } };
  const watch = stackWatchObligation({ stackId: result.stack_id, terminal: null, unread: true, freshCursor: true });
  return { summary: withWatchText(watch, summary), data: { ...result, watch } };
}
