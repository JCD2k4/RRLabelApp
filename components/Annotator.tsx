"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import AssistPanel from "./AssistPanel";
import Canvas, { type CanvasHandle } from "./Canvas";
import ClassPanel from "./ClassPanel";
import ExportDialog from "./ExportDialog";
import FrameList from "./FrameList";
import ProjectDialog from "./ProjectDialog";
import ShapePanel from "./ShapePanel";
import Toolbar from "./Toolbar";
import VideoDialog from "./VideoDialog";
import * as db from "@/lib/db";
import { clampPts } from "@/lib/geom";
import { contentId } from "@/lib/hash";
import { readDataset } from "@/lib/importDataset";
import { useAssist } from "@/lib/useAssist";
import { probe, type VideoInfo } from "@/lib/video";
import { PALETTE, uid, type Anns, type Cls, type Item, type Shape, type Tool } from "@/lib/types";

export default function Annotator() {
  const [items, setItems] = useState<Item[]>([]);
  const [anns, setAnns] = useState<Anns>({});
  const [classes, setClasses] = useState<Cls[]>([{ name: "object", color: PALETTE[0] }]);
  const [idx, setIdx] = useState(-1);
  const [activeCls, setActiveCls] = useState(0);
  const [tool, setTool] = useState<Tool>("box");
  const [selId, setSelId] = useState<string | null>(null);
  const [projId, setProjId] = useState("");
  const [projName, setProjName] = useState("dataset");
  const [projects, setProjects] = useState<db.Project[]>([]);
  const [showProjects, setShowProjects] = useState(false);
  const [projBusy, setProjBusy] = useState("");
  const [videos, setVideos] = useState<Record<string, db.VideoSource>>({});
  const [bitmap, setBitmap] = useState<ImageBitmap | null>(null);
  const [videoQueue, setVideoQueue] = useState<(VideoInfo & { hash: string })[]>([]);
  const [showExport, setShowExport] = useState(false);
  const [toast, setToast] = useState("");
  const [loaded, setLoaded] = useState(false);

  const canvasRef = useRef<CanvasHandle>(null);
  const undoRef = useRef<Record<string, string[]>>({});
  const createdRef = useRef(Date.now());
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const videosRef = useRef(videos);
  videosRef.current = videos;

  const item = idx >= 0 ? items[idx] ?? null : null;
  const shapes = item ? anns[item.id] ?? [] : [];

  const assist = useAssist({ items, anns, classes, idx, loaded });
  const { sugg, drop: dropSugg, refresh: askAgain } = assist;

  const say = useCallback((m: string, ms = 1800) => {
    setToast(m);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(""), ms);
  }, []);

  /* ------------------------------------------------------------ projects */
  /** Make a project the one on screen: its frames, classes and annotations. */
  const applyProject = useCallback(async (p: db.Project) => {
    const list = await db.loadItems(p.id, p.order);
    // frames stored before content ids existed: work them out once, so the
    // duplicate check covers everything the project already holds
    const legacy = list.filter((it) => !it.hash);
    if (legacy.length) {
      for (const it of legacy) it.hash = await contentId(it.blob);
      await db.putItems(legacy, p.id).catch(() => {});
    }
    createdRef.current = p.created;
    undoRef.current = {};
    setProjId(p.id);
    setProjName(p.name);
    setClasses(p.classes?.length ? p.classes : [{ name: "object", color: PALETTE[0] }]);
    setAnns(p.anns ?? {});
    setVideos(p.videos ?? {});
    setItems(list);
    setIdx(list.length ? 0 : -1);
    setSelId(null);
    await db.setCurrent(p.id);
  }, []);

  /** Write the open project out now, rather than waiting for the autosave. */
  const flush = useCallback(async (patch?: Partial<db.Project>) => {
    if (!projId) return;
    await db.saveProject({
      id: projId, name: projName, created: createdRef.current, updated: Date.now(),
      classes, anns, order: items.map((i) => i.id), videos, ...patch,
    }).catch(() => {});
  }, [projId, projName, classes, anns, items, videos]);

  /* ------------------------------------------------------------ restore */
  useEffect(() => {
    (async () => {
      try {
        const list = await db.listProjects();
        const id = await db.current();
        let p = list.find((x) => x.id === id) ?? list[0];
        if (!p) {
          p = db.blankProject("dataset");
          await db.saveProject(p);
        }
        await applyProject(p);
        if (p.order.length) say(`Restored "${p.name}" — ${p.order.length} frames`);
      } catch (e) {
        console.warn("restore failed", e);
      } finally {
        setLoaded(true);
      }
    })();
  }, [applyProject, say]);

  /* --------------------------------------------------------- autosave */
  useEffect(() => {
    if (!loaded || !projId) return;
    const t = setTimeout(() => void flush(), 300);
    return () => clearTimeout(t);
  }, [loaded, projId, flush]);

  /* ------------------------------------------------------ current frame */
  useEffect(() => {
    if (!item) {
      setBitmap(null);
      return;
    }
    let cancelled = false;
    createImageBitmap(item.blob).then((b) => {
      // Only a bitmap that never reached the canvas is safe to close by hand;
      // one that has been rendered is left to the GC, since closing it while a
      // pending paint still holds it detaches the image mid-draw.
      if (cancelled) b.close();
      else setBitmap(b);
    });
    return () => { cancelled = true; };
  }, [item]);

  useEffect(() => setSelId(null), [idx]);

  /* ---------------------------------------------------------- mutations */
  const snapshot = useCallback(() => {
    if (!item) return;
    const stack = (undoRef.current[item.id] ??= []);
    stack.push(JSON.stringify(anns[item.id] ?? []));
    if (stack.length > 60) stack.shift();
  }, [item, anns]);

  const setShapes = useCallback(
    (next: Shape[]) => {
      if (!item) return;
      setAnns((a) => ({ ...a, [item.id]: next }));
    },
    [item],
  );

  const addShape = useCallback(
    (sh: Shape) => {
      if (!item) return;
      snapshot();
      setAnns((a) => ({ ...a, [item.id]: [...(a[item.id] ?? []), sh] }));
      setSelId(sh.id);
    },
    [item, snapshot],
  );

  const deleteShape = useCallback(
    (id: string) => {
      if (!item) return;
      snapshot();
      setAnns((a) => ({ ...a, [item.id]: (a[item.id] ?? []).filter((s) => s.id !== id) }));
      setSelId((s) => (s === id ? null : s));
    },
    [item, snapshot],
  );

  const undo = useCallback(() => {
    if (!item) return;
    const stack = undoRef.current[item.id];
    if (!stack?.length) return say("Nothing to undo");
    const prev = JSON.parse(stack.pop()!) as Shape[];
    setAnns((a) => ({ ...a, [item.id]: prev }));
    setSelId(null);
  }, [item, say]);

  const copyPrev = useCallback(() => {
    if (idx <= 0) return say("No previous frame");
    const prev = anns[items[idx - 1].id] ?? [];
    if (!prev.length) return say("Previous frame is empty");
    snapshot();
    const clones = prev.map((s) => ({ ...s, id: uid(), pts: s.pts.map((p) => [...p] as [number, number]) }));
    setAnns((a) => ({ ...a, [items[idx].id]: [...(a[items[idx].id] ?? []), ...clones] }));
    say(`Copied ${clones.length} shape${clones.length > 1 ? "s" : ""}`);
  }, [idx, items, anns, snapshot, say]);

  const setClassOf = useCallback(
    (i: number) => {
      setActiveCls(i);
      if (selId && item) {
        snapshot();
        setAnns((a) => ({ ...a, [item.id]: (a[item.id] ?? []).map((s) => (s.id === selId ? { ...s, cls: i } : s)) }));
      }
    },
    [selId, item, snapshot],
  );

  /* -------------------------------------------------------- suggestions */
  const acceptSugg = useCallback(
    (ids: string[]) => {
      if (!item) return;
      const pick = sugg.filter((s) => ids.includes(s.id));
      if (!pick.length) return;
      snapshot();
      const made: Shape[] = pick.map((s) => ({ id: uid(), cls: s.cls, type: s.type, pts: clampPts(s.pts, item.w, item.h) }));
      setAnns((a) => ({ ...a, [item.id]: [...(a[item.id] ?? []), ...made] }));
      dropSugg(ids);
      setSelId(made.length === 1 ? made[0].id : null);
      if (made.length > 1) say(`Accepted ${made.length} suggestions`);
    },
    [item, sugg, dropSugg, snapshot, say],
  );

  const dismissAll = useCallback(() => {
    if (!sugg.length) return;
    dropSugg(sugg.map((s) => s.id));
    say(`Dismissed ${sugg.length} suggestion${sugg.length > 1 ? "s" : ""}`);
  }, [sugg, dropSugg, say]);

  /* ---------------------------------------------------- project actions */
  const openProjects = useCallback(async () => {
    setProjects(await db.listProjects().catch(() => []));
    setShowProjects(true);
  }, []);

  const switchTo = useCallback(async (id: string) => {
    setProjBusy("Opening…");
    await flush();
    const p = await db.getProject(id);
    if (p) await applyProject(p);
    setProjects(await db.listProjects().catch(() => []));
    setProjBusy("");
    setShowProjects(false);
    if (p) say(`Opened "${p.name}"`);
  }, [flush, applyProject, say]);

  const newProject = useCallback(async (name: string) => {
    setProjBusy("Creating…");
    await flush();
    const p = db.blankProject(name);
    await db.saveProject(p);
    await applyProject(p);
    setProjects(await db.listProjects().catch(() => []));
    setProjBusy("");
    setShowProjects(false);
    say(`New project "${name}"`);
  }, [flush, applyProject, say]);

  const renameProject = useCallback(async (id: string, name: string) => {
    if (id === projId) {
      setProjName(name);
      await flush({ name });          // before the list below is read back
    } else {
      const p = await db.getProject(id);
      if (p) await db.saveProject({ ...p, name });
    }
    setProjects(await db.listProjects().catch(() => []));
  }, [projId, flush]);

  const removeProject = useCallback(async (id: string) => {
    setProjBusy("Deleting…");
    await db.deleteProject(id).catch(() => {});
    let list = await db.listProjects().catch(() => []);
    if (id === projId) {
      let p = list[0];
      if (!p) {
        p = db.blankProject("dataset");
        await db.saveProject(p);
      }
      await applyProject(p);
      list = await db.listProjects().catch(() => []);
    }
    setProjects(list);
    setProjBusy("");
  }, [projId, applyProject]);

  /** A dataset ZIP comes back as a project of its own, so nothing is overwritten. */
  const importDataset = useCallback(async (file: File) => {
    setProjBusy(`Reading ${file.name}…`);
    try {
      const d = await readDataset(file);
      if (!d.items.length) throw new Error("No images found in that ZIP");
      await flush();
      const p = db.blankProject(d.name);
      p.classes = d.classes;
      p.anns = d.anns;
      p.order = d.items.map((i) => i.id);
      await db.saveProject(p);
      await db.putItems(d.items, p.id);
      await applyProject(p);
      setProjects(await db.listProjects().catch(() => []));
      setShowProjects(false);
      const shapes = Object.values(d.anns).reduce((n, l) => n + l.length, 0);
      say(`Imported ${d.items.length} frames · ${shapes} shapes into "${d.name}"` +
          (d.missing ? ` (${d.missing} frames had no image in the ZIP)` : ""), 4000);
    } catch (e) {
      say(e instanceof Error ? e.message : String(e), 4000);
    } finally {
      setProjBusy("");
    }
  }, [flush, applyProject, say]);

  /* ------------------------------------------------------------- import */
  const addItem = useCallback(async (it: Item) => {
    const full = it.hash ? it : { ...it, hash: await contentId(it.blob) };
    await db.putItem(full, projId).catch(() => {});
    setItems((prev) => {
      if (prev.length === 0) setIdx(0);
      return [...prev, full];
    });
  }, [projId]);

  /**
   * Re-adding a file is a no-op: images are matched on content, and a clip you
   * have already split asks first. Both checks are per project.
   */
  const importFiles = useCallback(
    async (files: FileList | File[]) => {
      const arr = [...files];
      const images = arr.filter((f) => f.type.startsWith("image/"));
      const clips = arr.filter((f) => f.type.startsWith("video/"));

      // what the project already holds, growing as we go so one drop that
      // repeats a file inside itself is caught too
      const seen = new Set(itemsRef.current.flatMap((it) => (it.hash ? [it.hash] : [])));
      let added = 0;
      let skipped = 0;
      for (const f of images) {
        const hash = await contentId(f);
        if (seen.has(hash)) {
          skipped++;
          continue;
        }
        seen.add(hash);
        const b = await createImageBitmap(f);
        await addItem({ id: uid("i"), name: f.name, w: b.width, h: b.height, blob: f, hash });
        b.close();
        added++;
      }
      if (images.length) {
        const n = (k: number) => `${k} image${k === 1 ? "" : "s"}`;
        say(
          !added ? `${n(skipped)} already in this project`
            : skipped ? `Added ${n(added)} · skipped ${skipped} already here`
            : `Added ${n(added)}`,
          skipped ? 3200 : 1800,
        );
      }

      const infos: (VideoInfo & { hash: string })[] = [];
      for (const v of clips) {
        try {
          const hash = await contentId(v);
          const prev = videosRef.current[hash];
          if (prev && !confirm(
            `"${prev.name}" is already split into ${prev.frames} frame${prev.frames === 1 ? "" : "s"}` +
            ` in this project. Split it again anyway?`)) continue;
          infos.push({ ...(await probe(v)), hash });
        } catch {
          say(`Could not read ${v.name}`);
        }
      }
      if (infos.length) setVideoQueue((q) => [...q, ...infos]);
    },
    [addItem, say],
  );

  useEffect(() => {
    const over = (e: DragEvent) => e.preventDefault();
    const drop = (e: DragEvent) => {
      e.preventDefault();
      if (e.dataTransfer?.files.length) void importFiles(e.dataTransfer.files);
    };
    window.addEventListener("dragover", over);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragover", over);
      window.removeEventListener("drop", drop);
    };
  }, [importFiles]);

  /* ----------------------------------------------------------- keyboard */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (/input|textarea|select/i.test(t.tagName)) return;
      const k = e.key;

      if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === "z") { e.preventDefault(); undo(); return; }
      if (k === " ") { e.preventDefault(); return; }
      if (k === "Escape") { if (!canvasRef.current?.cancelDraft()) setSelId(null); return; }
      if (k === "Enter") {
        if (!canvasRef.current?.commitDraft()) acceptSugg(sugg.map((s) => s.id));
        return;
      }
      if (k === "Backspace") {
        if (canvasRef.current?.popPoint()) { e.preventDefault(); return; }
        if (selId) { deleteShape(selId); e.preventDefault(); }
        return;
      }
      if (k === "Delete") { if (selId) deleteShape(selId); return; }

      const lk = k.toLowerCase();
      if (lk === "v") setTool("sel");
      else if (lk === "b") setTool("box");
      else if (lk === "p") setTool("poly");
      else if (lk === "f") canvasRef.current?.fit();
      else if (lk === "c") copyPrev();
      else if (lk === "x") dismissAll();
      else if (lk === "r") { if (!askAgain()) say("Assist isn't ready yet"); }
      else if (lk === "a" || k === "ArrowLeft") setIdx((i) => Math.max(0, i - 1));
      else if (lk === "d" || k === "ArrowRight") setIdx((i) => Math.min(items.length - 1, i + 1));
      else if (/^[1-9]$/.test(k)) {
        const i = +k - 1;
        if (i < classes.length) setClassOf(i);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, selId, deleteShape, copyPrev, items.length, classes.length, setClassOf, sugg, acceptSugg, dismissAll, askAgain, say]);

  /* -------------------------------------------------------------- render */
  const removeClass = (i: number) => {
    if (classes.length === 1) return say("Keep at least one class");
    if (!confirm(`Delete class "${classes[i].name}" and all its shapes?`)) return;
    setAnns((a) => {
      const out: Anns = {};
      for (const [k, list] of Object.entries(a))
        out[k] = list.filter((s) => s.cls !== i).map((s) => (s.cls > i ? { ...s, cls: s.cls - 1 } : s));
      return out;
    });
    setClasses((c) => c.filter((_, j) => j !== i));
    setActiveCls((c) => Math.max(0, Math.min(c, classes.length - 2)));
  };

  const wipe = async () => {
    if (!confirm("Delete every project, frame and annotation from this browser?")) return;
    await db.wipeAll().catch(() => {});
    location.reload();
  };

  return (
    <div className="app">
      <Toolbar
        tool={tool}
        setTool={setTool}
        idx={idx}
        count={items.length}
        projName={projName}
        onProjects={openProjects}
        onFiles={importFiles}
        onPrev={() => setIdx((i) => Math.max(0, i - 1))}
        onNext={() => setIdx((i) => Math.min(items.length - 1, i + 1))}
        onCopyPrev={copyPrev}
        onUndo={undo}
        onFit={() => canvasRef.current?.fit()}
        onExport={() => (items.length ? setShowExport(true) : say("Nothing to export yet"))}
        onWipe={wipe}
      />

      <main>
        <FrameList items={items} anns={anns} idx={idx} marks={assist.marks} onPick={setIdx} />

        <section className="stage">
          <Canvas
            ref={canvasRef}
            item={item}
            bitmap={bitmap}
            shapes={shapes}
            sugg={sugg}
            classes={classes}
            tool={tool}
            activeCls={activeCls}
            selId={selId}
            onSelect={setSelId}
            onAdd={addShape}
            onReplace={setShapes}
            onDelete={deleteShape}
            onBeforeEdit={snapshot}
            onAcceptSugg={(id) => acceptSugg([id])}
            onRejectSugg={(id) => dropSugg([id])}
          />
          {!item && (
            <div className="empty">
              <b>Drop images or a video here</b>
              <div>
                …or use <kbd>+ Images</kbd> / <kbd>+ Video</kbd> above.
                <br />
                Everything stays on this machine — nothing is uploaded.
              </div>
            </div>
          )}
          {toast && <div className="toast">{toast}</div>}
        </section>

        <aside className="right">
          <ClassPanel
            classes={classes}
            active={activeCls}
            onPick={setClassOf}
            onChange={(i, patch) => setClasses((c) => c.map((v, j) => (j === i ? { ...v, ...patch } : v)))}
            onAdd={() => {
              setClasses((c) => [...c, { name: `class${c.length + 1}`, color: PALETTE[c.length % PALETTE.length] }]);
              setActiveCls(classes.length);
            }}
            onRemove={removeClass}
          />
          <AssistPanel
            a={assist}
            onAcceptAll={() => acceptSugg(sugg.map((s) => s.id))}
            onDismissAll={dismissAll}
          />
          <ShapePanel
            shapes={shapes}
            classes={classes}
            selId={selId}
            onSelect={setSelId}
            onDelete={deleteShape}
          />
          <div className="help">
            <kbd>V</kbd>/<kbd>B</kbd>/<kbd>P</kbd> tools · <kbd>1</kbd>–<kbd>9</kbd> class
            <br />
            <kbd>A</kbd>/<kbd>D</kbd> prev/next frame · <kbd>C</kbd> copy prev
            <br />
            Mask: click dots, <kbd>Enter</kbd> or click 1st dot to close
            <br />
            <kbd>Del</kbd> delete · <kbd>Esc</kbd> cancel · <kbd>Ctrl+Z</kbd> undo
            <br />
            Suggestion: click accept · right-click dismiss
            <br />
            <kbd>Enter</kbd> accept all · <kbd>X</kbd> dismiss · <kbd>R</kbd> ask again
            <br />
            Wheel = zoom · drag middle/space = pan
          </div>
        </aside>
      </main>

      {videoQueue[0] && (
        <VideoDialog
          info={videoQueue[0]}
          onFrame={addItem}
          onDone={(added) => {
            const q = videoQueue[0];
            URL.revokeObjectURL(q.url);
            // remember the clip, so dropping it again asks instead of doubling up
            if (added) {
              setVideos((v) => ({
                ...v,
                [q.hash]: { name: q.file.name, frames: (v[q.hash]?.frames ?? 0) + added, added: Date.now() },
              }));
            }
            setVideoQueue((qq) => qq.slice(1));
          }}
        />
      )}

      {showProjects && (
        <ProjectDialog
          projects={projects}
          currentId={projId}
          busy={projBusy}
          onOpen={switchTo}
          onCreate={newProject}
          onRename={renameProject}
          onDelete={removeProject}
          onImport={importDataset}
          onClose={() => setShowProjects(false)}
        />
      )}

      {showExport && (
        <ExportDialog
          proj={projName}
          items={items}
          anns={anns}
          classes={classes}
          onClose={() => setShowExport(false)}
          onDone={(m) => { setShowExport(false); say(m, 3000); }}
        />
      )}
    </div>
  );
}
