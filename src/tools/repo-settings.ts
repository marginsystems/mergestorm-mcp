import {
  CommandError,
  REPO_SETTINGS_KEYS,
  listRepoSettings,
  patchRepoSettings,
  type Config,
  type RepoSettings,
  type RepoSettingsPatch,
} from "mergestorm/client";
import type { ToolPayload } from "./types.js";

const ARG_BY_KEY = {
  auto_patch_enabled: "auto_patch",
  auto_review_enabled: "auto_review",
  auto_land_default: "auto_land",
  merge_queue_batch_enabled: "merge_queue_batch",
  merge_queue_batch_size: "merge_queue_batch_size",
  merge_queue_lands_alone_paths: "merge_queue_lands_alone_paths",
  merge_queue_overdrive: "merge_queue_overdrive",
  issue_review_enabled: "issue_review",
} as const;

function parseRepo(raw: unknown): { owner: string; repo: string } {
  const match = typeof raw === "string" ? /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(raw.trim()) : null;
  if (!match) throw new CommandError("repo takes <owner>/<repo>.", 2, "usage");
  return { owner: match[1]!, repo: match[2]! };
}

function words(value: boolean | number | string[] | null): string {
  if (value === null) return "inherit";
  if (Array.isArray(value)) return value.length === 0 ? "none" : value.join(",");
  if (typeof value === "number") return String(value);
  return value ? "on" : "off";
}

function repoSettingsSummary(entry: RepoSettings): string {
  return `${entry.owner}/${entry.repo}: ${REPO_SETTINGS_KEYS.map((key) => `${ARG_BY_KEY[key]} ${words(entry[key])}`).join(" · ")}`;
}

export function repoSettingsPatchFromArgs(args: Record<string, unknown>): RepoSettingsPatch {
  const patch: RepoSettingsPatch = {};
  for (const key of REPO_SETTINGS_KEYS) {
    const value = args[ARG_BY_KEY[key]];
    if (value === undefined) continue;
    if (key === "merge_queue_batch_size") {
      if (value !== null && (typeof value !== "number" || !Number.isInteger(value))) {
        throw new CommandError(`${ARG_BY_KEY[key]} takes a whole number or null.`, 2, "usage");
      }
      patch[key] = value;
      continue;
    }
    if (key === "merge_queue_lands_alone_paths") {
      if (value !== null && !(Array.isArray(value) && value.every((entry) => typeof entry === "string"))) {
        throw new CommandError(`${ARG_BY_KEY[key]} takes a list of path patterns or null.`, 2, "usage");
      }
      patch[key] = value;
      continue;
    }
    if (value !== null && typeof value !== "boolean") {
      throw new CommandError(`${ARG_BY_KEY[key]} takes true, false, or null.`, 2, "usage");
    }
    patch[key] = value;
  }
  if (Object.keys(patch).length === 0) {
    throw new CommandError(
      `At least one of ${Object.values(ARG_BY_KEY).join(", ")} is required.`,
      2,
      "usage",
    );
  }
  return patch;
}

export async function repoSettingsGet(args: Record<string, unknown>, cfg?: Config): Promise<ToolPayload> {
  const wanted = args.repo === undefined ? null : parseRepo(args.repo);
  const all = await listRepoSettings(cfg);
  if (!wanted) {
    return {
      summary: all.length === 0 ? "No repositories are connected to this account." : all.map(repoSettingsSummary).join("\n"),
      data: { repos: all },
    };
  }
  const slug = `${wanted.owner}/${wanted.repo}`.toLowerCase();
  const entry = all.find((candidate) => `${candidate.owner}/${candidate.repo}`.toLowerCase() === slug);
  if (!entry) throw new CommandError(`${wanted.owner}/${wanted.repo} is not connected to this account.`);
  return { summary: repoSettingsSummary(entry), data: { ...entry } };
}

export async function repoSettingsSet(args: Record<string, unknown>, cfg?: Config): Promise<ToolPayload> {
  const { owner, repo } = parseRepo(args.repo);
  const entry = await patchRepoSettings(owner, repo, repoSettingsPatchFromArgs(args), cfg);
  return { summary: repoSettingsSummary(entry), data: { ...entry } };
}
