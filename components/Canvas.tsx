"use client";

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from "react";
import { bbox, clampPts, inPoly, shapePath } from "@/lib/geom";
import { uid, type Cls, type Item, type Pt, type Shape, type ShapeKind, type Sugg, type Tool } from "@/lib/types";

export interface CanvasHandle {
  fit: () => void;
  commitDraft: () => boolean;
  cancelDraft: () => boolean;
  popPoint: () => boolean;
}

interface Props {
  item: Item | null;
  bitmap: ImageBitmap | null;
  shapes: Shape[];
  sugg: Sugg[];
  classes: Cls[];
  tool: Tool;
  activeCls: number;
  selId: string | null;
  onSelect: (id: string | null) => void;
  onAdd: (sh: Shape) => void;
  onReplace: (shapes: Shape[]) => void;
  onDelete: (id: string) => void;
  onBeforeEdit: () => void;
  onAcceptSugg: (id: string) => void;
  onRejectSugg: (id: string) => void;
}

interface View { s: number; ox: number; oy: number }
interface Draft { type: ShapeKind; pts: Pt[]; hover: Pt | null }
type Drag =
  | { mode: "pan"; mx: number; my: number; ox: number; oy: number }
  | { mode: "box" }
  | { mode: "vert"; sh: Shape; i: number }
  | { mode: "move"; sh: Shape; ix: number; iy: number; orig: Pt[] };

const Canvas = forwardRef<CanvasHandle, Props>(function Canvas(props, ref) {
  const { item, bitmap, shapes, classes, tool, activeCls, selId } = props;

  const cvRef = useRef<HTMLCanvasElement>(null);
  const viewRef = useRef<View>({ s: 1, ox: 0, oy: 0 });
  const draftRef = useRef<Draft | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const workRef = useRef<Shape[] | null>(null);   // live copy while dragging
  const spaceRef = useRef(false);
  const propsRef = useRef(props);
  propsRef.current = props;

  const live = () => workRef.current ?? propsRef.current.shapes;
  const toImg = (px: number, py: number): Pt => {
    const v = viewRef.current;
    return [(px - v.ox) / v.s, (py - v.oy) / v.s];
  };
  const toScr = (x: number, y: number): Pt => {
    const v = viewRef.current;
    return [x * v.s + v.ox, y * v.s + v.oy];
  };

  /* ------------------------------------------------------------- drawing */
  const draw = useCallback(() => {
    const cv = cvRef.current;
    if (!cv) return;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    const W = cv.clientWidth;
    const H = cv.clientHeight;
    ctx.clearRect(0, 0, W, H);

    const { bitmap: bmp, classes: cls, activeCls: ac } = propsRef.current;
    if (!bmp) return;
    const v = viewRef.current;
    ctx.imageSmoothingEnabled = v.s < 3;
    ctx.drawImage(bmp, v.ox, v.oy, bmp.width * v.s, bmp.height * v.s);

    const colorOf = (i: number) => cls[i]?.color ?? "#ffffff";
    const nameOf = (i: number) => cls[i]?.name ?? "?";

    // suggestions sit underneath real shapes: dashed, faint, labelled with confidence
    ctx.font = "600 11px ui-sans-serif,system-ui";
    for (const sg of propsRef.current.sugg) {
      const pts = shapePath(sg);
      const col = colorOf(sg.cls);
      ctx.beginPath();
      pts.forEach(([x, y], i) => {
        const [sx, sy] = toScr(x, y);
        i ? ctx.lineTo(sx, sy) : ctx.moveTo(sx, sy);
      });
      ctx.closePath();
      ctx.fillStyle = col + "14";
      ctx.fill();
      ctx.setLineDash([6, 4]);
      ctx.lineWidth = 1.6;
      ctx.strokeStyle = col;
      ctx.stroke();
      ctx.setLineDash([]);

      const [x0, y0] = bbox(pts);
      const [sx, sy] = toScr(x0, y0);
      const label = `${nameOf(sg.cls)} ${Math.round(sg.score * 100)}%?`;
      ctx.fillStyle = "#0b0e13cc";
      ctx.fillRect(sx, sy - 15, ctx.measureText(label).width + 8, 15);
      ctx.fillStyle = col;
      ctx.fillText(label, sx + 4, sy - 4);
    }

    for (const sh of live()) {
      const selected = sh.id === propsRef.current.selId;
      const pts = shapePath(sh);
      const col = colorOf(sh.cls);

      ctx.beginPath();
      pts.forEach(([x, y], i) => {
        const [sx, sy] = toScr(x, y);
        i ? ctx.lineTo(sx, sy) : ctx.moveTo(sx, sy);
      });
      ctx.closePath();
      ctx.fillStyle = col + (selected ? "44" : "26");
      ctx.fill();
      ctx.lineWidth = selected ? 2.5 : 1.6;
      ctx.strokeStyle = col;
      ctx.stroke();

      if (selected || sh.type === "poly") {
        for (const [x, y] of sh.pts) {
          const [sx, sy] = toScr(x, y);
          ctx.beginPath();
          ctx.arc(sx, sy, selected ? 5 : 3.5, 0, Math.PI * 2);
          ctx.fillStyle = "#fff";
          ctx.fill();
          ctx.lineWidth = 2;
          ctx.strokeStyle = col;
          ctx.stroke();
        }
      }

      const [x0, y0] = bbox(pts);
      const [sx, sy] = toScr(x0, y0);
      const label = nameOf(sh.cls);
      ctx.font = "600 11px ui-sans-serif,system-ui";
      ctx.fillStyle = col;
      ctx.fillRect(sx, sy - 15, ctx.measureText(label).width + 8, 15);
      ctx.fillStyle = "#0b0e13";
      ctx.fillText(label, sx + 4, sy - 4);
    }

    const d = draftRef.current;
    if (d) {
      const col = colorOf(ac);
      ctx.strokeStyle = col;
      ctx.lineWidth = 1.8;
      ctx.setLineDash([5, 4]);
      if (d.type === "box") {
        const [a, b] = d.pts;
        const [x0, y0] = toScr(a[0], a[1]);
        const [x1, y1] = toScr(b[0], b[1]);
        ctx.fillStyle = col + "22";
        ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
        ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
      } else {
        const all = d.hover ? [...d.pts, d.hover] : d.pts;
        const trace = () =>
          all.forEach(([x, y], i) => {
            const [sx, sy] = toScr(x, y);
            i ? ctx.lineTo(sx, sy) : ctx.moveTo(sx, sy);
          });
        ctx.beginPath();
        trace();
        ctx.stroke();
        if (d.pts.length > 2) {
          ctx.beginPath();
          trace();
          ctx.closePath();
          ctx.fillStyle = col + "22";
          ctx.fill();
        }
        ctx.setLineDash([]);
        d.pts.forEach(([x, y], i) => {
          const [sx, sy] = toScr(x, y);
          ctx.beginPath();
          ctx.arc(sx, sy, i === 0 ? 6 : 4.5, 0, Math.PI * 2);
          ctx.fillStyle = i === 0 ? "#fff" : col;
          ctx.fill();
          ctx.lineWidth = 2;
          ctx.strokeStyle = col;
          ctx.stroke();
        });
      }
      ctx.setLineDash([]);
    }
  }, []);

  const fit = useCallback(() => {
    const cv = cvRef.current;
    const it = propsRef.current.item;
    if (!cv || !it) return;
    const s = Math.min(cv.clientWidth / it.w, cv.clientHeight / it.h) * 0.96;
    viewRef.current = { s, ox: (cv.clientWidth - it.w * s) / 2, oy: (cv.clientHeight - it.h * s) / 2 };
    draw();
  }, [draw]);

  /* ------------------------------------------------------- canvas sizing */
  useEffect(() => {
    const cv = cvRef.current;
    if (!cv) return;
    const ro = new ResizeObserver(() => {
      const dpr = window.devicePixelRatio || 1;
      cv.width = Math.round(cv.clientWidth * dpr);
      cv.height = Math.round(cv.clientHeight * dpr);
      cv.getContext("2d")?.setTransform(dpr, 0, 0, dpr, 0, 0);
      draw();
    });
    ro.observe(cv);
    return () => ro.disconnect();
  }, [draw]);

  // a new frame always gets a fresh fit
  useEffect(() => {
    draftRef.current = null;
    fit();
  }, [item?.id, bitmap, fit]);

  // any state change from the parent repaints
  useEffect(draw);

  useEffect(() => {
    const down = (e: KeyboardEvent) => { if (e.key === " ") spaceRef.current = true; };
    const up = (e: KeyboardEvent) => { if (e.key === " ") spaceRef.current = false; };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, []);

  /* ---------------------------------------------------------- hit testing */
  const hitVertex = (mx: number, my: number) => {
    for (const sh of [...live()].reverse())
      for (let i = 0; i < sh.pts.length; i++) {
        const [sx, sy] = toScr(sh.pts[i][0], sh.pts[i][1]);
        if (Math.hypot(sx - mx, sy - my) < 8) return { sh, i };
      }
    return null;
  };
  const hitShape = (ix: number, iy: number) => {
    for (const sh of [...live()].reverse()) if (inPoly([ix, iy], shapePath(sh))) return sh;
    return null;
  };
  const hitSugg = (ix: number, iy: number) => {
    for (const sg of [...propsRef.current.sugg].reverse()) if (inPoly([ix, iy], shapePath(sg))) return sg;
    return null;
  };

  /* ------------------------------------------------------------- editing */
  const commitDraft = useCallback(() => {
    const d = draftRef.current;
    draftRef.current = null;
    if (!d) return;
    if (d.type === "poly" && d.pts.length < 3) { draw(); return; }
    const it = propsRef.current.item;
    if (!it) return;
    propsRef.current.onAdd({
      id: uid(),
      cls: propsRef.current.activeCls,
      type: d.type,
      pts: clampPts(d.pts, it.w, it.h),
    });
  }, [draw]);

  useImperativeHandle(ref, () => ({
    fit,
    commitDraft: () => {
      const had = !!draftRef.current;
      commitDraft();
      return had;
    },
    cancelDraft: () => {
      if (!draftRef.current) return false;
      draftRef.current = null;
      draw();
      return true;
    },
    popPoint: () => {
      const d = draftRef.current;
      if (!d || !d.pts.length) return false;
      d.pts.pop();
      draw();
      return true;
    },
  }), [fit, commitDraft, draw]);

  /* -------------------------------------------------------------- events */
  const local = (e: React.PointerEvent) => {
    const r = (e.target as HTMLCanvasElement).getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top] as const;
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!item) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const [mx, my] = local(e);
    const [ix, iy] = toImg(mx, my);
    const v = viewRef.current;

    if (e.button === 1 || e.altKey || spaceRef.current) {
      dragRef.current = { mode: "pan", mx, my, ox: v.ox, oy: v.oy };
      return;
    }

    if (e.button === 2) {
      const hv = hitVertex(mx, my);
      if (hv && hv.sh.type === "poly" && hv.sh.pts.length > 3) {
        props.onBeforeEdit();
        props.onReplace(shapes.map((s) => (s.id === hv.sh.id ? { ...s, pts: s.pts.filter((_, i) => i !== hv.i) } : s)));
        return;
      }
      const sh = hitShape(ix, iy);
      if (sh) return props.onDelete(sh.id);
      const sg = hitSugg(ix, iy);
      if (sg) props.onRejectSugg(sg.id);
      return;
    }

    if (tool === "poly") {
      const d = draftRef.current ?? { type: "poly" as const, pts: [], hover: null };
      draftRef.current = d;
      if (d.pts.length > 2) {
        const [fx, fy] = toScr(d.pts[0][0], d.pts[0][1]);
        if (Math.hypot(fx - mx, fy - my) < 10) return commitDraft();
      }
      d.pts.push([ix, iy]);
      draw();
      return;
    }

    if (tool === "box") {
      draftRef.current = { type: "box", pts: [[ix, iy], [ix, iy]], hover: null };
      dragRef.current = { mode: "box" };
      return;
    }

    const hv = hitVertex(mx, my);
    if (hv) {
      props.onBeforeEdit();
      props.onSelect(hv.sh.id);
      workRef.current = shapes.map((s) => ({ ...s, pts: s.pts.map((p) => [...p] as Pt) }));
      const sh = workRef.current.find((s) => s.id === hv.sh.id)!;
      dragRef.current = { mode: "vert", sh, i: hv.i };
      return;
    }
    const hs = hitShape(ix, iy);
    if (hs) {
      props.onBeforeEdit();
      props.onSelect(hs.id);
      workRef.current = shapes.map((s) => ({ ...s, pts: s.pts.map((p) => [...p] as Pt) }));
      const sh = workRef.current.find((s) => s.id === hs.id)!;
      dragRef.current = { mode: "move", sh, ix, iy, orig: sh.pts.map((p) => [...p] as Pt) };
      return;
    }
    const sg = hitSugg(ix, iy);
    if (sg) return props.onAcceptSugg(sg.id);
    props.onSelect(null);
    dragRef.current = { mode: "pan", mx, my, ox: v.ox, oy: v.oy };
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const [mx, my] = local(e);
    const [ix, iy] = toImg(mx, my);
    const drag = dragRef.current;

    if (!drag) {
      if (tool === "poly" && draftRef.current) {
        draftRef.current.hover = [ix, iy];
        draw();
      }
      const cv = cvRef.current;
      if (cv)
        cv.style.cursor =
          tool === "sel"
            ? hitVertex(mx, my) ? "grab" : hitShape(ix, iy) ? "move" : hitSugg(ix, iy) ? "copy" : "default"
            : "crosshair";
      return;
    }

    switch (drag.mode) {
      case "pan": {
        viewRef.current = { ...viewRef.current, ox: drag.ox + (mx - drag.mx), oy: drag.oy + (my - drag.my) };
        break;
      }
      case "box":
        if (draftRef.current) draftRef.current.pts[1] = [ix, iy];
        break;
      case "vert":
        drag.sh.pts[drag.i] = [ix, iy];
        break;
      case "move":
        drag.sh.pts = drag.orig.map(([x, y]) => [x + (ix - drag.ix), y + (iy - drag.iy)] as Pt);
        break;
    }
    draw();
  };

  const onPointerUp = () => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag) return;

    if (drag.mode === "box") {
      const d = draftRef.current;
      if (d) {
        const [a, b] = d.pts;
        if (Math.abs(a[0] - b[0]) > 3 && Math.abs(a[1] - b[1]) > 3) commitDraft();
        else {
          // a click rather than a drag: on a suggestion, that means "yes, that one"
          draftRef.current = null;
          const sg = hitSugg(a[0], a[1]);
          if (sg) props.onAcceptSugg(sg.id);
          else draw();
        }
      }
      return;
    }
    if ((drag.mode === "vert" || drag.mode === "move") && workRef.current && item) {
      const next = workRef.current.map((s) => ({ ...s, pts: clampPts(s.pts, item.w, item.h) }));
      workRef.current = null;
      props.onReplace(next);
    }
  };

  useEffect(() => {
    const cv = cvRef.current;
    if (!cv) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = cv.getBoundingClientRect();
      const mx = e.clientX - r.left;
      const my = e.clientY - r.top;
      const [ix, iy] = toImg(mx, my);
      const v = viewRef.current;
      const s = Math.max(0.02, Math.min(80, v.s * Math.exp(-e.deltaY * 0.0015)));
      viewRef.current = { s, ox: mx - ix * s, oy: my - iy * s };
      draw();
    };
    cv.addEventListener("wheel", onWheel, { passive: false });
    return () => cv.removeEventListener("wheel", onWheel);
  }, [draw]);

  const zoomPct = Math.round(viewRef.current.s * 100);

  return (
    <>
      <canvas
        ref={cvRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onContextMenu={(e) => e.preventDefault()}
      />
      {item && (
        <div className="status">
          {item.name} · {item.w}×{item.h} · {zoomPct}% · {shapes.length} shape{shapes.length === 1 ? "" : "s"}
        </div>
      )}
    </>
  );
});

export default Canvas;
