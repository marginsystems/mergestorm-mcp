import {
  CommandError,
  BEARER_SETTINGS,
  SETTINGS_WRITABLE_KEYS,
  patchSettings,
  type Config,
  type SettingsPatch,
} from "mergestorm/client";
import { settingsSummary } from "./settings-get.js";
import type { ToolPayload } from "./types.js";

/** Read-only on `/api/v1/settings`; the API owns them, agents never write them. */
export const SETTINGS_READ_ONLY_KEYS = [
  "cyclone_connected",
  "github_connected",
] as const;

/**
 * Build a PATCH body from raw tool args. Only the Bearer-writable allowlist
 * passes through; read-only keys and empty patches are usage errors so the
 * failure is the caller's wording, never a silent no-op.
 */
export function settingsPatchFromArgs(
  args: Record<string, unknown>,
): SettingsPatch {
  for (const key of SETTINGS_READ_ONLY_KEYS) {
    if (args[key] !== undefined) {
      throw new CommandError(`${key} is read-only and cannot be set.`, 2, "usage");
    }
  }
  const patch: SettingsPatch = {};
  for (const key of SETTINGS_WRITABLE_KEYS) {
    const value = args[key];
    if (value === undefined) continue;
    const row = BEARER_SETTINGS.find((row) => row.key === key)!;
    if ("kind" in row && row.kind === "seconds") {
      if (
        typeof value !== "number" ||
        !Number.isInteger(value) ||
        value < row.min ||
        value > row.max
      ) {
        throw new CommandError(
          `${key} takes a whole number of seconds from ${row.min} through ${row.max}.`,
          2,
          "usage",
        );
      }
      Object.assign(patch, { [key]: value });
      continue;
    }
    if ("kind" in row) {
      const valid = row.kind === "logins"
        ? Array.isArray(value) && value.every((login) => typeof login === "string")
        : typeof value === "string" && (row.values as readonly string[]).includes(value);
      if (!valid) throw new CommandError(`Invalid value for ${key}.`, 2, "usage");
      Object.assign(patch, { [key]: value });
      continue;
    }
    if (typeof value !== "boolean") {
      throw new CommandError(`${key} takes a boolean.`, 2, "usage");
    }
    Object.assign(patch, { [key]: value });
  }
  if (Object.keys(patch).length === 0) {
    throw new CommandError(
      `At least one settings key is required: ${SETTINGS_WRITABLE_KEYS.join(", ")}.`,
      2,
      "usage",
    );
  }
  return patch;
}

export async function settingsSet(
  args: Record<string, unknown>,
  cfg?: Config,
): Promise<ToolPayload> {
  const patch = settingsPatchFromArgs(args);
  const settings = await patchSettings(patch, cfg);
  return {
    summary: settingsSummary(settings),
    data: { ...settings },
  };
}
