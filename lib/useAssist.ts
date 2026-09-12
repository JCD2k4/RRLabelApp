"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as api from "./assist";
import { bbox, shapePath } from "./geom";
import { uid, type Anns, type Cls, type Item, type Pt, type Sugg } from "./types";

const KEY = "masker.assist";

function iou(a: number[], b: number[]) {
  const ix = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const iy = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const inter = ix * iy;
  const union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter;
  return union > 0 ? inter / union : 0;
}

interface Args {
  items: Item[];
  anns: Anns;
  classes: Cls[];
  idx: number;
  loaded: boolean;
}

/**
 * Talks to assist.py. Every frame you leave is taught to the model; the frame
 * you land on gets the model's guesses back as suggestions. Nothing becomes an
 * annotation until it is accepted.
 */
export function useAssist({ items, anns, classes, idx, loaded }: Args) {
  const [enabled, setEnabledState] = useState(true);
  const [status, setStatus] = useState<api.AssistStatus | null>(null);
  const [online, setOnline] = useState(false);
  const [dets, setDets] = useState<Record<string, api.Det[]>>({});
  const [threshold, setThreshold] = useState(0.5);
  const [predicting, setPredicting] = useState(false);
  const [pending, setPending] = useState(0);

  const live = useRef({ items, anns, classes, idx, loaded, threshold });
  live.current = { items, anns, classes, idx, loaded, threshold };
  const detsRef = useRef(dets);
  detsRef.current = dets;
  const known = useRef<Record<string, string>>({});   // what the trainer holds, by signature
  const syncing = useRef(false);
  const failed = useRef<Record<string, number>>({});  // frames the trainer refused, and when
  // `known` drives the sync loop; this mirror of it drives the per-frame markers
  const [synced, setSynced] = useState<Record<string, string>>({});
  const publish = useCallback(() => setSynced({ ...known.current }), []);

  const item = idx >= 0 ? items[idx] : undefined;
  const ready = enabled && online && !!status?.ready;

  useEffect(() => {
    try {
      if (localStorage.getItem(KEY) === "0") setEnabledState(false);
    } catch { /* storage blocked — stay on */ }
  }, []);

  const setEnabled = useCallback((on: boolean) => {
    setEnabledState(on);
    try { localStorage.setItem(KEY, on ? "1" : "0"); } catch { /* not remembered, still applied */ }
  }, []);

  /* ------------------------------------------------------------ sync */
  /** Bring the trainer's copy of every frame — except the one you're on — up to date. */
  const sync = useCallback(async () => {
    if (syncing.current || !live.current.loaded) return;
    syncing.current = true;
    let fails = 0;
    try {
      for (let pass = 0; pass < 3; pass++) {
        const { items, anns, classes, idx } = live.current;
        const cur = items[idx]?.id;
        const ids = new Set(items.map((i) => i.id));
        const stale = Object.keys(known.current).filter((id) => !ids.has(id));
        const todo = items.filter((it) => {
          if (it.id === cur) return false;
          if ((failed.current[it.id] ?? 0) > Date.now() - 30_000) return false;   // cooling off
          const sh = anns[it.id] ?? [];
          return (sh.length ? api.signature(sh, classes) : undefined) !== known.current[it.id];
        });
        if (!stale.length && !todo.length) break;
        setPending(stale.length + todo.length);

        for (const id of stale) {
          await api.forget(id);
          delete known.current[id];
          publish();
          setPending((n) => Math.max(0, n - 1));
        }
        for (const it of todo) {
          const { items, anns, classes, idx } = live.current;
          if (items[idx]?.id === it.id) continue;       // you went back to it; wait until you leave
          const sh = anns[it.id] ?? [];
          try {
            if (sh.length) {
              const sig = api.signature(sh, classes);
              await api.learn(it, sh, classes, sig);
              known.current[it.id] = sig;
            } else if (known.current[it.id]) {
              await api.forget(it.id);                  // you cleared it
              delete known.current[it.id];
            }
            delete failed.current[it.id];
          } catch (e) {
            // one bad frame must not be retried every poll, nor stop the others
            failed.current[it.id] = Date.now();
            if (++fails >= 3) throw e;                  // the trainer is gone, not the frame
          }
          publish();
          setPending((n) => Math.max(0, n - 1));
        }
      }
    } catch {
      /* trainer went away — the next poll retries */
    } finally {
      syncing.current = false;
      setPending(0);
    }
  }, [publish]);

  /* ------------------------------------------------------------ poll */
  const poll = useCallback(async () => {
    try {
      const s = await api.status();
      if (!syncing.current) {
        known.current = { ...s.samples };
        publish();
      }
      setStatus(s);
      setOnline(true);
      return true;
    } catch {
      setOnline(false);
      return false;
    }
  }, [publish]);

  useEffect(() => {
    if (!enabled) {
      setOnline(false);
      return;
    }
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      const ok = await poll();
      if (stop) return;
      if (ok) void sync();
      timer = setTimeout(tick, ok ? 3000 : 15000);
    };
    void tick();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [enabled, poll, sync]);

  /* --------------------------------------------------------- predict */
  const predictFor = useCallback(async (it: Item) => {
    setPredicting(true);
    try {
      const raw = await api.predict(it);
      setDets((d) => ({ ...d, [it.id]: raw.map((r) => ({ ...r, id: uid("g") })) }));
    } catch {
      /* offline — nothing to suggest */
    } finally {
      setPredicting(false);
    }
  }, []);

  // switching frames: teach the one you left, ask about the one you opened
  useEffect(() => {
    if (!enabled || !online) return;
    void sync();
    if (ready && item) void predictFor(item);
  }, [item, enabled, online, ready, sync, predictFor]);

  // once a round of training settles, retry an empty frame that got nothing useful
  const training = !!status?.training;
  const wasTraining = useRef(false);
  useEffect(() => {
    const was = wasTraining.current;
    wasTraining.current = training;
    if (!was || training || !ready) return;
    const { items, idx, anns, threshold } = live.current;
    const it = items[idx];
    if (!it || anns[it.id]?.length) return;
    if ((detsRef.current[it.id] ?? []).some((d) => d.score >= threshold)) return;
    void predictFor(it);
  }, [training, ready, predictFor]);

  /* ------------------------------------------------------ suggestions */
  const sugg = useMemo<Sugg[]>(() => {
    if (!enabled || !online || !item) return [];
    // offer each class the way you have been drawing it: dots if mostly masks, else a box
    const lean = new Array<number>(classes.length).fill(0);
    for (const list of Object.values(anns)) for (const s of list) lean[s.cls] += s.type === "poly" ? 1 : -1;
    const byName = new Map(classes.map((c, i) => [c.name, i]));
    const mine = (anns[item.id] ?? []).map((s) => bbox(shapePath(s)));
    const out: Sugg[] = [];
    for (const d of dets[item.id] ?? []) {
      const cls = byName.get(d.cls);
      if (cls === undefined || d.score < threshold) continue;
      if (mine.some((b) => iou(b, d.box) >= 0.5)) continue;      // you already drew it
      const poly = lean[cls] > 0 && d.poly && d.poly.length >= 3 ? d.poly : null;
      const pts: Pt[] = poly ?? [[d.box[0], d.box[1]], [d.box[2], d.box[3]]];
      out.push({ id: d.id, cls, score: d.score, type: poly ? "poly" : "box", pts });
    }
    return out;
  }, [enabled, online, item, anns, classes, dets, threshold]);

  /**
   * Per frame: has the trainer got what is on screen right now? Anything you
   * draw or change reads "pending" until it has been handed over — which happens
   * when you leave the frame.
   */
  const marks = useMemo<Record<string, "learned" | "pending">>(() => {
    if (!enabled || !online) return {};
    const out: Record<string, "learned" | "pending"> = {};
    for (const it of items) {
      const sh = anns[it.id] ?? [];
      const want = sh.length ? api.signature(sh, classes) : undefined;
      if (!want && !synced[it.id]) continue;             // empty and never sent: nothing to say
      out[it.id] = want && synced[it.id] === want ? "learned" : "pending";
    }
    return out;
  }, [enabled, online, items, anns, classes, synced]);

  /** Forget suggestions on the current frame (after accepting or dismissing them). */
  const drop = useCallback((ids: string[]) => {
    const it = live.current.items[live.current.idx];
    if (!it) return;
    setDets((d) => ({ ...d, [it.id]: (d[it.id] ?? []).filter((x) => !ids.includes(x.id)) }));
  }, []);

  const refresh = useCallback(() => {
    const it = live.current.items[live.current.idx];
    if (!it || !ready) return false;
    void predictFor(it);
    return true;
  }, [ready, predictFor]);

  const resetModel = useCallback(async () => {
    try { await api.reset(); } catch { /* offline; nothing to reset */ }
    known.current = {};
    setDets({});
    if (await poll()) void sync();
  }, [poll, sync]);

  return {
    enabled, setEnabled, online, status, ready, sugg, marks, drop, refresh, resetModel,
    threshold, setThreshold, predicting, pending,
    // from the same mirror the frame markers use, so the count and the dots agree
    learned: Object.keys(synced).length,
  };
}

export type Assist = ReturnType<typeof useAssist>;
