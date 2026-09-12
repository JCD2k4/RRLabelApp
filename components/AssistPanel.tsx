"use client";

import type { Assist } from "@/lib/useAssist";

export default function AssistPanel({
  a, onAcceptAll, onDismissAll,
}: {
  a: Assist;
  onAcceptAll: () => void;
  onDismissAll: () => void;
}) {
  const s = a.online ? a.status : null;
  const state = !a.enabled ? "off" : !s ? "offline" : !a.ready ? "learning" : "live";
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

  return (
    <div className="pblock">
      <div className="phead">
        Assist <span className={`led ${state}`} /> <span>{state}</span>
        <span className="spacer" />
        <input
          type="checkbox"
          checked={a.enabled}
          title="Suggest shapes from a model that trains as you annotate"
          onChange={(e) => a.setEnabled(e.target.checked)}
        />
      </div>
      {a.enabled && (
        <div className="help assist">
          {!s ? (
            <>
              Start the trainer to get suggestions:
              <br />
              <kbd>python assist.py</kbd>
            </>
          ) : (
            <>
              <div>
                {s.device} · {plural(a.learned, "frame")} learned · step {s.steps}
                {s.loss != null && ` · loss ${s.loss.toFixed(2)}`}
                {s.training && " · training…"}
              </div>
              {s.note && <div className="warn">⚠ {s.note}</div>}
              {a.pending > 0 && <div>sending {plural(a.pending, "frame")}…</div>}
              <div>
                frames: <i className="mk learned" /> learned · <i className="mk pending" /> not sent yet
              </div>
              {!a.ready ? (
                <div>Learning — suggestions start after {s.min_frames} annotated frames.</div>
              ) : (
                <>
                  <div className="row">
                    <span style={{ flex: 1 }}>{a.predicting ? "thinking…" : plural(a.sugg.length, "suggestion")}</span>
                    <button disabled={!a.sugg.length} onClick={onAcceptAll} title="Accept all (Enter)">✓ all</button>
                    <button disabled={!a.sugg.length} onClick={onDismissAll} title="Dismiss all (X)">✕</button>
                    <button onClick={() => a.refresh()} title="Ask again (R)">↻</button>
                  </div>
                  <div className="row">
                    <label style={{ flex: 1 }}>min confidence</label>
                    <input
                      type="range"
                      min={0.25}
                      max={0.95}
                      step={0.05}
                      value={a.threshold}
                      onChange={(e) => a.setThreshold(+e.target.value)}
                    />
                    <span style={{ width: 30, textAlign: "right" }}>{Math.round(a.threshold * 100)}%</span>
                  </div>
                </>
              )}
              <button
                className="x"
                onClick={() => {
                  if (confirm("Throw away everything the assistant has learned?")) void a.resetModel();
                }}
              >
                reset model
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
