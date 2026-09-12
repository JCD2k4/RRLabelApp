"use client";

import { contentId } from "./hash";
import { unzip } from "./unzip";
import { PALETTE, uid, type Anns, type Cls, type Item, type Pt, type Shape } from "./types";

export interface Imported {
  name: string;
  items: Item[];
  anns: Anns;
  classes: Cls[];
  missing: number;        // frames named in the annotations whose image was not in the ZIP
}

interface CocoImage { id: number; file_name: string; width?: number; height?: number }
interface CocoAnn {
  image_id: number;
  category_id: number;
  bbox?: [number, number, number, number];
  segmentation?: unknown;
  shape_type?: string;
}
interface Coco {
  info?: { description?: string };
  images?: CocoImage[];
  annotations?: CocoAnn[];
  categories?: { id: number; name: string; color?: string }[];
}

const IMAGE_EXT = /\.(png|jpe?g|webp|bmp|gif)$/i;
const base = (p: string) => p.slice(p.lastIndexOf("/") + 1);

const mime = (name: string) => {
  const e = name.toLowerCase().match(IMAGE_EXT)?.[1];
  return e === "png" ? "image/png"
    : e === "webp" ? "image/webp"
    : e === "bmp" ? "image/bmp"
    : e === "gif" ? "image/gif"
    : "image/jpeg";
};

/** Pairs of numbers as COCO writes them: [x1,y1,x2,y2,…]. */
const toPts = (flat: number[]): Pt[] => {
  const pts: Pt[] = [];
  for (let i = 0; i + 1 < flat.length; i += 2) pts.push([flat[i], flat[i + 1]]);
  return pts;
};

async function sizeOf(blob: Blob) {
  const b = await createImageBitmap(blob);
  const wh = { w: b.width, h: b.height };
  b.close();
  return wh;
}

/**
 * Read a dataset ZIP back into frames, shapes and classes — the reverse of
 * exportDataset. Understands what we write (`shape_type` tells a box from a
 * mask) and falls back sensibly for COCO from other tools, or a plain folder of
 * images with no annotations at all.
 */
export async function readDataset(file: File): Promise<Imported> {
  const files = await unzip(await file.arrayBuffer());

  const byBase = new Map<string, Uint8Array>();
  for (const [path, bytes] of files) if (IMAGE_EXT.test(path)) byBase.set(base(path), bytes);

  const cocoPath = [...files.keys()].find((p) => base(p) === "annotations.json");
  const coco: Coco = cocoPath ? JSON.parse(new TextDecoder().decode(files.get(cocoPath)!)) : {};

  /* classes: from the categories we wrote (colours and all), else classes.txt, else one default */
  const cats = [...(coco.categories ?? [])].sort((a, b) => a.id - b.id);
  const classesTxt = [...files.keys()].find((p) => base(p) === "classes.txt");
  let classes: Cls[] = cats.map((c, i) => ({ name: c.name, color: c.color ?? PALETTE[i % PALETTE.length] }));
  if (!classes.length && classesTxt) {
    classes = new TextDecoder().decode(files.get(classesTxt)!)
      .split("\n").map((s) => s.trim()).filter(Boolean)
      .map((name, i) => ({ name, color: PALETTE[i % PALETTE.length] }));
  }
  if (!classes.length) classes = [{ name: "object", color: PALETTE[0] }];
  const clsOf = new Map(cats.map((c, i) => [c.id, i]));

  /* frames: those the annotations name, then any leftover images in the ZIP */
  const items: Item[] = [];
  const anns: Anns = {};
  const idOf = new Map<number, string>();
  const used = new Set<string>();
  let missing = 0;

  for (const im of coco.images ?? []) {
    const bytes = byBase.get(base(im.file_name));
    if (!bytes) {
      missing++;                                    // exported without images/
      continue;
    }
    const blob = new Blob([bytes as BlobPart], { type: mime(im.file_name) });
    const size = im.width && im.height ? { w: im.width, h: im.height } : await sizeOf(blob);
    const id = uid("i");
    idOf.set(im.id, id);
    used.add(base(im.file_name));
    items.push({ id, name: base(im.file_name), w: size.w, h: size.h, blob, hash: await contentId(blob) });
    anns[id] = [];
  }

  for (const [name, bytes] of byBase) {
    if (used.has(name)) continue;
    const blob = new Blob([bytes as BlobPart], { type: mime(name) });
    const size = await sizeOf(blob);
    const id = uid("i");
    items.push({ id, name, w: size.w, h: size.h, blob, hash: await contentId(blob) });
    anns[id] = [];
  }

  /* shapes */
  for (const a of coco.annotations ?? []) {
    const frame = idOf.get(a.image_id);
    if (!frame) continue;
    const seg = Array.isArray(a.segmentation) && Array.isArray(a.segmentation[0])
      ? toPts(a.segmentation[0] as number[])
      : null;                                       // RLE masks are not editable here
    const box = a.bbox;
    // we write shape_type; without it, treat a real polygon as a mask and anything else as a box
    const asPoly = a.shape_type ? a.shape_type === "poly" : !!seg && seg.length > 4;
    let pts: Pt[] | null = asPoly && seg ? seg : null;
    if (!pts && box) pts = [[box[0], box[1]], [box[0] + box[2], box[1] + box[3]]];
    if (!pts && seg) pts = seg;
    if (!pts || pts.length < 2) continue;
    const shape: Shape = {
      id: uid(),
      cls: clsOf.get(a.category_id) ?? Math.max(0, a.category_id - 1),
      type: pts.length > 2 ? "poly" : "box",
      pts,
    };
    if (shape.cls >= classes.length) continue;      // a category we have no class for
    anns[frame].push(shape);
  }

  const stem = file.name.replace(/\.zip$/i, "");
  return { name: coco.info?.description || stem || "imported", items, anns, classes, missing };
}
