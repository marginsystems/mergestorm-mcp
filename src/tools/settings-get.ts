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
  const cyclone = settings.cyclone_connected
    ? "Cyclone connected"
    : "Cyclone not connected";
  return `auto_patch ${autoPatch} · ${cyclone}`;
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
