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
  return `${stack.owner}/${stack.repo} · ${layerLabel} · ${currentState}`;
}
