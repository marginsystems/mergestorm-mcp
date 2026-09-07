import type { StackDto } from "mergestorm/client";

export function stackSummary(stack: StackDto): string {
  const count = stack.layers.length;
  const layerLabel = `${count} layer${count === 1 ? "" : "s"}`;
  const states = [...new Set(stack.layers.map((layer) => layer.state))];
  const currentState =
    states.length > 0
      ? `layers: ${states.join(", ")}`
      : stack.unit
        ? `unit: ${stack.unit.state}`
        : "no open layers";
  const overrides: string[] = [];
  if (typeof stack.autoReviewOverride === "boolean") {
    overrides.push(`auto-review ${stack.autoReviewOverride ? "on" : "off"}`);
  }
  if (typeof stack.autoPatchOverride === "boolean") {
    overrides.push(`auto-patch ${stack.autoPatchOverride ? "on" : "off"}`);
  }
  if (stack.cycloneOwnerMatch) {
    overrides.push(`cyclone-owner ${stack.cycloneOwnerMatch}`);
  }
  return `${stack.owner}/${stack.repo} · ${layerLabel} · ${currentState} · auto-land ${
    stack.autoEnqueueWhenReady ? "on" : "off"
  }${overrides.map((label) => ` · ${label}`).join("")}`;
}
