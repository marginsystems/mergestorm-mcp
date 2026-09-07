import { CommandError, getMe, loadConfig, type Config } from "mergestorm/client";
import type { ToolPayload } from "./types.js";

export async function credits(cfg?: Config): Promise<ToolPayload> {
  const resolved = cfg ?? (await loadConfig());
  const me = await getMe(resolved);
  if (!me) {
    throw new CommandError(
      "Credits are not available right now (Mergestorm API is offline, unreachable, or too old).",
    );
  }
  if (!me.usage) {
    throw new CommandError(
      "Credits are not available on this server yet. Update the API or use the dashboard.",
    );
  }
  const standard = me.usage.standard;
  const remaining =
    standard.remaining ??
    (standard.limit != null ? Math.max(0, standard.limit - standard.used) : null);
  const bonusRemaining = (
    me.usage as typeof me.usage & { bonus?: { remaining: number } }
  ).bonus?.remaining;
  const bonusSummary =
    bonusRemaining == null ? "" : ` · ${bonusRemaining} bonus remaining`;
  return {
    summary:
      remaining == null
        ? `${standard.used} used · unlimited${bonusSummary}`
        : `${standard.used} used · ${remaining} remaining${bonusSummary}`,
    data: {
      usage: me.usage,
      resets_at: me.resets_at ?? null,
    },
  };
}
