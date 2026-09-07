import {
  CommandError,
  apiBase,
  configPath,
  getMe,
  loadConfig,
  resolveApiKey,
  type Config,
} from "mergestorm/client";
import type { ToolPayload } from "./types.js";

export async function whoami(cfg?: Config): Promise<ToolPayload> {
  const resolved = cfg ?? (await loadConfig());
  const key = resolveApiKey(resolved);
  if (!key) {
    throw new CommandError(
      "No API key. Run `mergestorm login` or set MERGESTORM_API_KEY.",
      1,
      "missing_api_key",
    );
  }
  const me = await getMe(resolved);
  if (!me) {
    throw new CommandError("Live account details unavailable. Could not verify account with /me.");
  }
  const data = {
    key_prefix: me.key.prefix,
    key_name: me.key.name ?? null,
    plan_key: me.plan_key ?? null,
    plan_label_key: me.plan_label_key ?? null,
    api_base: apiBase(resolved),
    config_path: configPath(),
    usage: me.usage ?? null,
  };
  const plan = data.plan_label_key ?? data.plan_key ?? "unknown plan";
  return {
    summary: `${data.key_prefix} · ${plan}`,
    data,
  };
}
