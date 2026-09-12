"use client";

import { useState } from "react";
import Modal from "./Modal";
import { buildDataset, download, type ExportOpts } from "@/lib/exportDataset";
import type { Anns, Cls, Item } from "@/lib/types";

export default function ExportDialog({
  proj, items, anns, classes, onClose, onDone,
}: {
  proj: string;
  items: Item[];
  anns: Anns;
  classes: Cls[];
  onClose: () => void;
  onDone: (msg: string) => void;
}) {
  const [opts, setOpts] = useState<ExportOpts>({
    images: true, coco: true, masks: true, yolo: false, skipEmpty: true, valSplit: 0.2,
  });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [frac, setFrac] = useState(0);
  const set = (patch: Partial<ExportOpts>) => setOpts((o) => ({ ...o, ...patch }));

  const run = async () => {
    setBusy(true);
    try {
      const { blob, images, shapes } = await buildDataset({
        proj, items, anns, classes, opts,
        onProgress: (m, f) => { setMsg(m); setFrac(f); },
      });
      download(blob, `${proj.replace(/[^A-Za-z0-9._-]+/g, "_") || "dataset"}.zip`);
      onDone(`Exported ${images} images / ${shapes} shapes`);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  const check = (key: keyof ExportOpts, label: string, hint: string) => (
    <label className="chk">
      <input type="checkbox" checked={opts[key] as boolean} disabled={busy}
             onChange={(e) => set({ [key]: e.target.checked } as Partial<ExportOpts>)} />
      {label} <span style={{ color: "var(--dim)" }}>{hint}</span>
    </label>
  );

  return (
    <Modal>
      <h3>Export dataset</h3>
      {check("images", "images/", "the frames themselves")}
      {check("coco", "annotations.json", "COCO: boxes + polygons")}
      {check("masks", "masks/", "PNG, pixel value = class id")}
      {check("yolo", "labels/", "YOLO txt boxes")}
      {check("skipEmpty", "skip frames with no shapes", "")}

      <div className="fld">
        <label>Validation split</label>
        <input type="number" value={Math.round(opts.valSplit * 100)} min={0} max={90} step={5}
               style={{ width: 64 }} disabled={busy}
               onChange={(e) => set({ valSplit: +e.target.value / 100 })} /> %
      </div>

      <div className="bar"><div style={{ width: `${frac * 100}%` }} /></div>
      <div style={{ color: "var(--dim)", marginTop: 6, minHeight: 16 }}>{msg}</div>

      <div className="row" style={{ marginTop: 12 }}>
        <span className="spacer" />
        <button className="ghost" onClick={onClose} disabled={busy}>Cancel</button>
        <button className="on" onClick={run} disabled={busy}>⭳ Build ZIP</button>
      </div>
    </Modal>
  );
}
