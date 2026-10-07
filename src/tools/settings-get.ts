import {
  CommandError,
  getSettings,
  type Config,
  type SettingsResponse,
} from "mergestorm/client";
import type { ToolPayload } from "./types.js";

/**
 * One line an agent can act on without opening the data: is Cyclone allowed
 * to patch, and is it even connected.
 */
export function settingsSummary(settings: SettingsResponse): string {
  const autoPatch = settings.auto_patch_enabled ? "on" : "off";
  const automations = [
    settings.auto_resolve_conflicts_enabled ? "auto_resolve_conflicts on" : null,
    settings.auto_fix_ci_enabled ? "auto_fix_ci on" : null,
  ].filter((label): label is string => label !== null);
  const autoPatchLabel = [`auto_patch ${autoPatch}`, ...automations].join(" · ");
  const cyclone = settings.cyclone_connected
    ? "Cyclone connected"
    : "Cyclone not connected";
  if (typeof settings.stacks_ready !== "boolean") return `${autoPatchLabel} · ${cyclone}`;
  const stacks = settings.stacks_ready
    ? "stacks, merge queue and Auto land ready"
    : "stacks, merge queue and Auto land not ready (install Mergestorm Surge)";
  return `${autoPatchLabel} · ${cyclone} (auto patch) · ${stacks}`;
}

export async function settingsGet(cfg?: Config): Promise<ToolPayload> {
  const settings = await getSettings(cfg);
  if (!settings) {
    throw new CommandError(
      "Settings are not available (offline or API too old). " +
        "Try again or open https://mergestorm.ai/settings",
    );
  }
  return {
    summary: settingsSummary(settings),
    data: { ...settings },
  };
}
