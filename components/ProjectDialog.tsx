"use client";

import { useRef } from "react";
import Modal from "./Modal";
import type { Project } from "@/lib/db";

const ago = (t: number) => {
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 90) return "just now";
  const m = s / 60;
  if (m < 90) return `${Math.round(m)} min ago`;
  const h = m / 60;
  if (h < 36) return `${Math.round(h)} h ago`;
  return `${Math.round(h / 24)} days ago`;
};

export default function ProjectDialog({
  projects, currentId, busy, onOpen, onCreate, onRename, onDelete, onImport, onClose,
}: {
  projects: Project[];
  currentId: string;
  busy: string;
  onOpen: (id: string) => void;
  onCreate: (name: string) => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
  onImport: (file: File) => void;
  onClose: () => void;
}) {
  const zipRef = useRef<HTMLInputElement>(null);

  const shapesIn = (p: Project) => Object.values(p.anns).reduce((n, list) => n + list.length, 0);

  return (
    <Modal>
      <h3>Projects</h3>
      <div className="plist">
        {projects.map((p) => {
          const here = p.id === currentId;
          return (
            <div key={p.id} className={`prow${here ? " sel" : ""}`}>
              <button
                className="pick"
                disabled={here || !!busy}
                title={here ? "This is the project you have open" : "Open this project"}
                onClick={() => onOpen(p.id)}
              >
                <b>{p.name}</b>
                <span>
                  {p.order.length} frame{p.order.length === 1 ? "" : "s"} · {shapesIn(p)} shape
                  {shapesIn(p) === 1 ? "" : "s"} · {ago(p.updated)}
                  {here && " · open"}
                </span>
              </button>
              <button
                className="x"
                title="Rename"
                disabled={!!busy}
                onClick={() => {
                  const name = prompt("Project name", p.name)?.trim();
                  if (name && name !== p.name) onRename(p.id, name);
                }}
              >
                ✎
              </button>
              <button
                className="x"
                title="Delete this project and its frames"
                disabled={!!busy}
                onClick={() => {
                  if (confirm(`Delete "${p.name}" and its ${p.order.length} frames? This cannot be undone.`))
                    onDelete(p.id);
                }}
              >
                ✕
              </button>
            </div>
          );
        })}
        {!projects.length && <div className="help">No projects yet.</div>}
      </div>

      <div style={{ color: "var(--dim)", marginTop: 8, minHeight: 16 }}>{busy}</div>

      <div className="row" style={{ marginTop: 10 }}>
        <button
          disabled={!!busy}
          onClick={() => {
            const name = prompt("New project name", "dataset")?.trim();
            if (name) onCreate(name);
          }}
        >
          + New project
        </button>
        <button disabled={!!busy} onClick={() => zipRef.current?.click()} title="Load a dataset ZIP exported earlier">
          ⭱ Import dataset…
        </button>
        <input
          ref={zipRef}
          type="file"
          accept=".zip,application/zip"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (f) onImport(f);
          }}
        />
        <span className="spacer" />
        <button className="on" disabled={!!busy} onClick={onClose}>Close</button>
      </div>
    </Modal>
  );
}
