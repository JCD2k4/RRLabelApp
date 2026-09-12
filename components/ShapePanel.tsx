"use client";

import type { Cls, Shape } from "@/lib/types";

export default function ShapePanel({
  shapes, classes, selId, onSelect, onDelete,
}: {
  shapes: Shape[];
  classes: Cls[];
  selId: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <div className="pblock" style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
      <div className="phead">
        Shapes on this frame <span className="spacer" />
        <span>{shapes.length}</span>
      </div>
      <div className="pbody">
        {shapes.length === 0 ? (
          <div className="help">
            Nothing yet. Pick <kbd>B</kbd> for a box or <kbd>P</kbd> for a dot mask.
          </div>
        ) : (
          shapes.map((s) => (
            <div
              key={s.id}
              className={`ann${s.id === selId ? " sel" : ""}`}
              onClick={() => onSelect(s.id)}
            >
              <span className="dot" style={{ background: classes[s.cls]?.color ?? "#fff" }} />
              <span style={{ flex: 1 }}>{classes[s.cls]?.name ?? "?"}</span>
              <span style={{ color: "var(--dim)" }}>{s.type === "box" ? "box" : `${s.pts.length} pts`}</span>
              <button
                className="x"
                onClick={(e) => { e.stopPropagation(); onDelete(s.id); }}
              >
                ✕
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
