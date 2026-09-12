"use client";

import type { Cls } from "@/lib/types";

export default function ClassPanel({
  classes, active, onPick, onChange, onAdd, onRemove,
}: {
  classes: Cls[];
  active: number;
  onPick: (i: number) => void;
  onChange: (i: number, patch: Partial<Cls>) => void;
  onAdd: () => void;
  onRemove: (i: number) => void;
}) {
  return (
    <div className="pblock">
      <div className="phead">
        Classes <span className="spacer" />
        <button className="x" onClick={onAdd}>+ add</button>
      </div>
      {classes.map((c, i) => (
        <div key={i} className={`cls${i === active ? " sel" : ""}`} onClick={() => onPick(i)}>
          <span className="key">{i < 9 ? i + 1 : "·"}</span>
          <input
            type="color"
            className="sw"
            value={c.color}
            title="Colour"
            onChange={(e) => onChange(i, { color: e.target.value })}
          />
          <input
            type="text"
            value={c.name}
            onChange={(e) => onChange(i, { name: e.target.value })}
          />
          <button className="x" title="Remove class" onClick={() => onRemove(i)}>✕</button>
        </div>
      ))}
    </div>
  );
}
