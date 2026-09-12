"use client";

import { useMemo, useState } from "react";
import Modal from "./Modal";
import { extractFrames, plannedFrames, type ExtractOpts, type VideoInfo } from "@/lib/video";
import type { Item } from "@/lib/types";

export default function VideoDialog({
  info, onFrame, onDone,
}: {
  info: VideoInfo;
  onFrame: (it: Item) => void | Promise<void>;
  onDone: (added: number) => void;
}) {
  const [fps, setFps] = useState(2);
  const [start, setStart] = useState(0);
  const [end, setEnd] = useState(+info.duration.toFixed(1));
  const [max, setMax] = useState(300);
  const [resize, setResize] = useState(0);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(0);
  const [total, setTotal] = useState(0);

  const opts: ExtractOpts = useMemo(
    () => ({ fps, start, end, max, resize }),
    [fps, start, end, max, resize],
  );
  const planned = plannedFrames(opts);

  const run = async () => {
    setBusy(true);
    setTotal(planned);
    let added = 0;
    await extractFrames(info, opts, async (item, i, n) => {
      await onFrame(item);
      added++;
      setDone(i);
      setTotal(n);
    });
    onDone(added);
  };

  return (
    <Modal>
      <h3>Split “{info.file.name}” into frames</h3>
      <div style={{ color: "var(--dim)", marginBottom: 8 }}>
        {info.duration.toFixed(1)}s · {info.width}×{info.height}
      </div>

      <div className="fld">
        <label>Frames per second to grab</label>
        <input type="number" value={fps} min={0.1} max={60} step={0.1} style={{ width: 80 }}
               onChange={(e) => setFps(+e.target.value)} disabled={busy} />
      </div>
      <div className="fld">
        <label>Start / end (s)</label>
        <input type="number" value={start} min={0} step={0.1} style={{ width: 70 }}
               onChange={(e) => setStart(+e.target.value)} disabled={busy} />
        <input type="number" value={end} min={0} step={0.1} style={{ width: 70 }}
               onChange={(e) => setEnd(+e.target.value)} disabled={busy} />
      </div>
      <div className="fld">
        <label>Max frames</label>
        <input type="number" value={max} min={1} style={{ width: 80 }}
               onChange={(e) => setMax(+e.target.value)} disabled={busy} />
      </div>
      <div className="fld">
        <label>Resize longest side to (0 = keep)</label>
        <input type="number" value={resize} min={0} step={16} style={{ width: 80 }}
               onChange={(e) => setResize(+e.target.value)} disabled={busy} />
      </div>

      <div style={{ color: "var(--dim)", margin: "6px 0" }}>
        {busy ? `${done} / ${total} frames` : `→ about ${planned} frames`}
      </div>
      <div className="bar">
        <div style={{ width: `${total ? (done / total) * 100 : 0}%` }} />
      </div>

      <div className="row" style={{ marginTop: 12 }}>
        <span className="spacer" />
        <button className="ghost" onClick={() => onDone(0)} disabled={busy}>Cancel</button>
        <button className="on" onClick={run} disabled={busy || planned === 0}>Extract</button>
      </div>
    </Modal>
  );
}
