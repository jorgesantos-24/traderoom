export const FONT = "'Inter Variable', system-ui, sans-serif";

/** '#rrggbb' (or '#rgb') with an alpha, as a CSS rgba() string. */
export function rgba(hex: string, a: number): string {
  let h = hex.replace('#', '');
  if (h.length === 3) h = [...h].map((x) => x + x).join('');
  const n = parseInt(h.slice(0, 6), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
