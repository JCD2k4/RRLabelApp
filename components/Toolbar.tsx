"use client";

import { useRef } from "react";
import type { Tool } from "@/lib/types";

export default function Toolbar({
  tool, setTool, idx, count, projName, onProjects,
  onFiles, onPrev, onNext, onCopyPrev, onUndo, onFit, onExport, onWipe,
}: {
  tool: Tool;
  setTool: (t: Tool) => void;
  idx: number;
  count: number;
  projName: string;
  onProjects: () => void;
  onFiles: (files: FileList | File[]) => void;
  onPrev: () => void;
  onNext: () => void;
  onCopyPrev: () => void;
  onUndo: () => void;
  onFit: () => void;
  onExport: () => void;
  onWipe: () => void;
}) {
  const imgRef = useRef<HTMLInputElement>(null);
  const vidRef = useRef<HTMLInputElement>(null);

  const pick = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files?.length) onFiles(e.target.files);
    e.target.value = "";
  };

  return (
    <header>
      <span className="brand">◈ FOLKISTAN</span>
      <div className="sep" />

      <button onClick={() => imgRef.current?.click()}>+ Images</button>
      <button onClick={() => vidRef.current?.click()}>+ Video</button>
      <input ref={imgRef} type="file" accept="image/*" multiple hidden onChange={pick} />
      <input ref={vidRef} type="file" accept="video/*" multiple hidden onChange={pick} />
      <div className="sep" />

      <button className={tool === "sel" ? "on" : ""} onClick={() => setTool("sel")} title="Select / edit (V)">▶ Select</button>
      <button className={tool === "box" ? "on" : ""} onClick={() => setTool("box")} title="Bounding box (B)">▭ Box</button>
      <button className={tool === "poly" ? "on" : ""} onClick={() => setTool("poly")} title="Polygon mask — click dots (P)">⬡ Mask</button>
      <div className="sep" />

      <button onClick={onPrev} title="Previous frame (A)">◀</button>
      <span style={{ color: "var(--dim)", minWidth: 74, textAlign: "center" }}>{idx + 1} / {count}</span>
      <button onClick={onNext} title="Next frame (D)">▶</button>
      <div className="sep" />

      <button onClick={onCopyPrev} title="Copy annotations from previous frame (C)">⧉ Copy prev</button>
      <button onClick={onUndo} title="Undo (Ctrl+Z)">↶ Undo</button>
      <button onClick={onFit} title="Fit to screen (F)">⤢ Fit</button>

      <div className="spacer" />
      <button onClick={onProjects} title="Projects — switch, rename, import a dataset ZIP">
        ▤ {projName}
      </button>
      <button className="on" onClick={onExport}>⭳ Export</button>
      <button className="ghost" onClick={onWipe} title="Delete every project">🗑</button>
    </header>
  );
}
