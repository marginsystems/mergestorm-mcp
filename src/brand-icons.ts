export type MarkRect = { x: number; y: number; width: number; height: number };

export type McpIcon = {
  src: string;
  mimeType: string;
  sizes: string[];
  theme?: "light" | "dark";
};

export const MARK_RECTS: readonly MarkRect[] = [
  { x: 103.685, y: 79.639, width: 336.635, height: 32.005 },
  { x: 71.68, y: 143.816, width: 288.545, height: 32.005 },
  { x: 103.685, y: 207.993, width: 192.363, height: 32.005 },
  { x: 151.775, y: 272.002, width: 176.277, height: 32.005 },
  { x: 215.952, y: 336.179, width: 96.182, height: 32.005 },
  { x: 264.043, y: 400.356, width: 32.005, height: 32.005 },
];

const SITE = "https://mergestorm.ai";

export function markSvg(fill: string): string {
  const rects = MARK_RECTS.map(
    (r) => `<rect x="${r.x}" y="${r.y}" width="${r.width}" height="${r.height}" fill="${fill}"/>`,
  ).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="64 64 384 384">${rects}</svg>`;
}

function svgDataUri(svg: string): string {
  return `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
}

export const MCP_SERVER_ICONS: McpIcon[] = [
  { src: svgDataUri(markSvg("#000000")), mimeType: "image/svg+xml", sizes: ["any"], theme: "light" },
  { src: svgDataUri(markSvg("#ffffff")), mimeType: "image/svg+xml", sizes: ["any"], theme: "dark" },
  { src: `${SITE}/images/android-chrome-192x192.png`, mimeType: "image/png", sizes: ["192x192"] },
  { src: `${SITE}/images/android-chrome-512x512.png`, mimeType: "image/png", sizes: ["512x512"] },
];

export const MCP_WEBSITE_URL = SITE;
