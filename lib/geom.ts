import type { Pt, Shape } from "./types";

export function bbox(pts: Pt[]): [number, number, number, number] {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) {
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  }
  return [x0, y0, x1, y1];
}

/** A box is stored as two corners; drawing and export both want four. */
export function rectPts(pts: Pt[]): Pt[] {
  const [x0, y0, x1, y1] = bbox(pts);
  return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
}

export const shapePath = (sh: Shape): Pt[] => (sh.type === "box" ? rectPts(sh.pts) : sh.pts);

export function inPoly(pt: Pt, pts: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if (yi > pt[1] !== yj > pt[1] && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export const clampPts = (pts: Pt[], w: number, h: number): Pt[] =>
  pts.map(([x, y]) => [Math.max(0, Math.min(w, x)), Math.max(0, Math.min(h, y))] as Pt);
