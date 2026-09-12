"use client";

import type { Cls, Item, Pt, Shape } from "./types";

/** The Python trainer (assist.py) sits behind this prefix — next.config rewrites it. */
const BASE = "/assist";

export interface AssistStatus {
  device: string;
  note: string;
  classes: string[];
  samples: Record<string, string>;   // item id -> signature of the shapes it learned
  steps: number;
  loss: number | null;
  training: boolean;
  ready: boolean;
  min_frames: number;
}

/** One raw detection; `id` is ours so a suggestion can be accepted or dismissed. */
export interface Det {
  id: string;
  cls: string;
  score: number;
  box: [number, number, number, number];
  poly: Pt[] | null;
}

async function call<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(
    BASE + path,
    body === undefined
      ? { cache: "no-store" }
      : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
  );
  if (!r.ok) throw new Error(`assist ${path}: ${r.status}`);
  return r.json() as Promise<T>;
}

const base64 = (blob: Blob) =>
  new Promise<string>((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(String(fr.result).slice(String(fr.result).indexOf(",") + 1));
    fr.onerror = () => rej(fr.error);
    fr.readAsDataURL(blob);
  });

/** Everything the trainer learns from a frame, squashed into one comparable string. */
export function signature(shapes: Shape[], classes: Cls[]): string {
  const s = JSON.stringify(
    shapes.map((sh) => [classes[sh.cls]?.name ?? "?", sh.type, sh.pts.map(([x, y]) => [Math.round(x), Math.round(y)])]),
  );
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return `${shapes.length}:${h.toString(36)}`;
}

export const status = () => call<AssistStatus>("/status");
export const forget = (id: string) => call("/forget", { id });
export const reset = () => call("/reset", {});

export async function learn(it: Item, shapes: Shape[], classes: Cls[], sig: string) {
  await call("/learn", {
    id: it.id,
    w: it.w,
    h: it.h,
    sig,
    image: await base64(it.blob),
    shapes: shapes.map((s) => ({ cls: classes[s.cls]?.name ?? "?", type: s.type, pts: s.pts })),
  });
}

export async function predict(it: Item): Promise<Omit<Det, "id">[]> {
  const r = await call<{ ready: boolean; dets: Omit<Det, "id">[] }>("/predict", {
    id: it.id,
    w: it.w,
    h: it.h,
    image: await base64(it.blob),
  });
  return r.dets;
}
