"use client";

import { bbox, shapePath } from "./geom";
import type { Anns, Cls, Item } from "./types";
import { blobBytes, utf8, zip, type ZipFile } from "./zip";

export interface ExportOpts {
  images: boolean;
  coco: boolean;
  masks: boolean;
  yolo: boolean;
  skipEmpty: boolean;
  valSplit: number;   // 0..1
}

export interface ExportInput {
  proj: string;
  items: Item[];
  anns: Anns;
  classes: Cls[];
  opts: ExportOpts;
  onProgress?: (msg: string, frac: number) => void;
}

interface CocoAnn {
  id: number;
  image_id: number;
  category_id: number;
  iscrowd: 0;
  bbox: [number, number, number, number];
  area: number;
  segmentation: number[][];
  shape_type: string;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

export async function buildDataset(inp: ExportInput): Promise<{ blob: Blob; images: number; shapes: number }> {
  const { proj, anns, classes, opts } = inp;
  const tick = inp.onProgress ?? (() => {});
  const items = inp.items.filter((it) => !opts.skipEmpty || (anns[it.id]?.length ?? 0) > 0);
  if (!items.length) throw new Error("No annotated frames to export");

  const files: ZipFile[] = [];
  const used = new Set<string>();
  const stemOf = (name: string) => {
    const base = name.replace(/\.[^.]+$/, "").replace(/[^A-Za-z0-9._-]+/g, "_");
    let s = base;
    let n = 1;
    while (used.has(s)) s = `${base}_${n++}`;
    used.add(s);
    return s;
  };

  const coco = {
    info: { description: proj, generator: "robotics_mask annotator", date: new Date().toISOString() },
    licenses: [] as unknown[],
    images: [] as { id: number; file_name: string; width: number; height: number }[],
    annotations: [] as CocoAnn[],
    categories: classes.map((c, i) => ({ id: i + 1, name: c.name, supercategory: "object", color: c.color })),
  };

  const maskCanvas = document.createElement("canvas");
  const mx = maskCanvas.getContext("2d")!;
  const train: string[] = [];
  const val: string[] = [];
  let annId = 1;

  for (let n = 0; n < items.length; n++) {
    const it = items[n];
    const ext = (it.name.match(/\.[^.]+$/)?.[0] ?? ".png").toLowerCase();
    const stem = stemOf(it.name);
    const fname = stem + ext;
    const shapes = anns[it.id] ?? [];
    tick(`Packing ${n + 1} / ${items.length} — ${it.name}`, n / items.length);
    // yield to the browser so the progress bar actually paints
    await new Promise((r) => setTimeout(r, 0));

    if (opts.images) files.push({ name: `images/${fname}`, data: await blobBytes(it.blob) });

    coco.images.push({ id: n + 1, file_name: fname, width: it.w, height: it.h });
    for (const sh of shapes) {
      const pts = shapePath(sh);
      const [x0, y0, x1, y1] = bbox(pts);
      coco.annotations.push({
        id: annId++,
        image_id: n + 1,
        category_id: sh.cls + 1,
        iscrowd: 0,
        bbox: [r2(x0), r2(y0), r2(x1 - x0), r2(y1 - y0)],
        area: r2((x1 - x0) * (y1 - y0)),
        segmentation: [pts.flatMap((p) => [r2(p[0]), r2(p[1])])],
        shape_type: sh.type,
      });
    }

    if (opts.yolo) {
      const txt = shapes
        .map((sh) => {
          const [x0, y0, x1, y1] = bbox(shapePath(sh));
          const v = [(x0 + x1) / 2 / it.w, (y0 + y1) / 2 / it.h, (x1 - x0) / it.w, (y1 - y0) / it.h];
          return [sh.cls, ...v.map((k) => k.toFixed(6))].join(" ");
        })
        .join("\n");
      files.push({ name: `labels/${stem}.txt`, data: utf8(txt + (txt ? "\n" : "")) });
    }

    if (opts.masks) {
      maskCanvas.width = it.w;
      maskCanvas.height = it.h;
      mx.fillStyle = "#000";
      mx.fillRect(0, 0, it.w, it.h);
      for (const sh of shapes) {
        const v = sh.cls + 1;
        mx.fillStyle = `rgb(${v},${v},${v})`;
        mx.beginPath();
        shapePath(sh).forEach(([x, y], i) => (i ? mx.lineTo(x, y) : mx.moveTo(x, y)));
        mx.closePath();
        mx.fill();
      }
      const png = await new Promise<Blob | null>((r) => maskCanvas.toBlob(r, "image/png"));
      if (png) files.push({ name: `masks/${stem}.png`, data: await blobBytes(png) });
    }

    (Math.random() < opts.valSplit ? val : train).push(fname);
  }

  tick("Writing metadata…", 0.97);
  if (opts.coco) files.push({ name: "annotations.json", data: utf8(JSON.stringify(coco, null, 1)) });
  files.push({ name: "classes.txt", data: utf8(classes.map((c) => c.name).join("\n") + "\n") });
  files.push({ name: "splits/train.txt", data: utf8(train.join("\n") + "\n") });
  files.push({ name: "splits/val.txt", data: utf8(val.join("\n") + "\n") });

  // the loader ships with the data so the exported folder stands on its own
  try {
    const py = await fetch("/dataset.py").then((r) => (r.ok ? r.text() : ""));
    if (py) files.push({ name: "dataset.py", data: utf8(py) });
  } catch {
    /* export is still valid without it */
  }

  files.push({
    name: "README.txt",
    data: utf8(`${proj} — exported by the MASKER annotator
${coco.images.length} images, ${coco.annotations.length} shapes, ${classes.length} classes.

images/            source frames
masks/             semantic masks, PNG, pixel value = class id (0 = background)
annotations.json   COCO-style: bbox [x,y,w,h] + polygon segmentation, category_id = class id
labels/            YOLO txt (class cx cy w h, normalised) — only if you ticked it
classes.txt        class names, line N = class id N
splits/            train / val file name lists
dataset.py         ready-made PyTorch Dataset (detection + segmentation)

  from dataset.py:  ds = MaskerDataset(".", split="train", mode="detection")
`),
  });

  tick("Zipping…", 0.99);
  return { blob: zip(files), images: coco.images.length, shapes: coco.annotations.length };
}

export function download(blob: Blob, filename: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 30_000);
}
