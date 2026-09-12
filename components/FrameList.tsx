"use client";

import { useEffect, useRef, useState } from "react";
import type { Anns, Item } from "@/lib/types";

export default function FrameList({
  items, anns, idx, marks, onPick,
}: {
  items: Item[];
  anns: Anns;
  idx: number;
  marks: Record<string, "learned" | "pending">;
  onPick: (i: number) => void;
}) {
  const [urls, setUrls] = useState<Record<string, string>>({});
  const cache = useRef<Record<string, string>>({});
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let changed = false;
    for (const it of items) {
      if (!cache.current[it.id]) {
        cache.current[it.id] = URL.createObjectURL(it.blob);
        changed = true;
      }
    }
    for (const id of Object.keys(cache.current)) {
      if (!items.some((it) => it.id === id)) {
        URL.revokeObjectURL(cache.current[id]);
        delete cache.current[id];
        changed = true;
      }
    }
    if (changed) setUrls({ ...cache.current });
  }, [items]);

  useEffect(() => {
    const c = cache.current;
    return () => Object.values(c).forEach(URL.revokeObjectURL);
  }, []);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-i="${idx}"]`)?.scrollIntoView({ block: "nearest" });
  }, [idx]);

  return (
    <aside className="left">
      <div className="phead">
        Frames <span className="spacer" />
        <span>{items.length}</span>
      </div>
      <div className="pbody" ref={listRef}>
        {items.map((it, i) => {
          const n = anns[it.id]?.length ?? 0;
          const mark = marks[it.id];
          return (
            <button
              key={it.id}
              data-i={i}
              className={`thumb${i === idx ? " sel" : ""}`}
              onClick={() => onPick(i)}
            >
              {urls[it.id] && <img src={urls[it.id]} alt="" loading="lazy" />}
              <span style={{ minWidth: 0, flex: 1 }}>
                <span className="nm" style={{ display: "block" }}>{it.name}</span>
                <span className={`ct${n ? " has" : ""}`}>
                  {n ? `${n} shape${n > 1 ? "s" : ""}` : "—"}
                  {mark && (
                    <i
                      className={`mk ${mark}`}
                      title={mark === "learned"
                        ? "the assistant has this version of the frame"
                        : "not sent yet — the assistant gets it when you leave this frame"}
                    />
                  )}
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </aside>
  );
}
