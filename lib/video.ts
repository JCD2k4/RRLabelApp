"use client";

import type { Item } from "./types";
import { uid } from "./types";

export interface VideoInfo {
  file: File;
  url: string;
  duration: number;
  width: number;
  height: number;
}

/**
 * Streamed recordings (anything MediaRecorder wrote — screen captures, webcam
 * clips) carry no duration in their header and report Infinity. Seeking past the
 * end forces the browser to work the real length out.
 */
function resolveDuration(v: HTMLVideoElement): Promise<number> {
  if (Number.isFinite(v.duration) && v.duration > 0) return Promise.resolve(v.duration);
  return new Promise((resolve) => {
    const done = (d: number) => {
      v.removeEventListener("durationchange", onChange);
      clearTimeout(timer);
      resolve(d);
    };
    const onChange = () => {
      if (Number.isFinite(v.duration)) {
        v.currentTime = 0;
        done(v.duration);
      }
    };
    const timer = setTimeout(() => done(Number.isFinite(v.duration) ? v.duration : 0), 4000);
    v.addEventListener("durationchange", onChange);
    v.currentTime = 1e101;
  });
}

/** Read a video's metadata without decoding the whole thing. */
export function probe(file: File): Promise<VideoInfo> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement("video");
    v.preload = "metadata";
    v.muted = true;
    v.src = url;
    v.onloadedmetadata = async () => {
      const duration = await resolveDuration(v);
      resolve({ file, url, duration, width: v.videoWidth, height: v.videoHeight });
    };
    v.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Could not read that video"));
    };
  });
}

function seek(v: HTMLVideoElement, t: number): Promise<void> {
  return new Promise((res) => {
    const on = () => {
      v.removeEventListener("seeked", on);
      setTimeout(res, 0);
    };
    v.addEventListener("seeked", on);
    v.currentTime = Math.min(t, Math.max(0, v.duration - 1e-3));
  });
}

export interface ExtractOpts {
  fps: number;
  start: number;
  end: number;
  max: number;
  resize: number;   // longest side, 0 = keep original
}

/** The exact timestamps that will be grabbed — the dialog's estimate and the
 *  extraction loop both read from here so they can never disagree. */
export function frameTimes(o: ExtractOpts): number[] {
  const times: number[] = [];
  if (!(o.fps > 0) || !(o.end > o.start)) return times;
  for (let t = o.start; t < o.end - 1e-4 && times.length < o.max; t += 1 / o.fps) times.push(t);
  return times;
}

export const plannedFrames = (o: ExtractOpts): number => frameTimes(o).length;

/** Seek-and-grab: reliable across codecs, and fast enough for a few hundred frames. */
export async function extractFrames(
  info: VideoInfo,
  o: ExtractOpts,
  onFrame: (item: Item, done: number, total: number) => void | Promise<void>,
): Promise<void> {
  const v = document.createElement("video");
  v.preload = "auto";
  v.muted = true;
  v.src = info.url;
  await new Promise<void>((res) => {
    if (v.readyState >= 2) return res();
    v.onloadeddata = () => res();
  });

  const times = frameTimes(o);

  let W = info.width;
  let H = info.height;
  if (o.resize > 0) {
    const k = o.resize / Math.max(W, H);
    if (k < 1) {
      W = Math.round(W * k);
      H = Math.round(H * k);
    }
  }

  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const cx = c.getContext("2d")!;
  const base = info.file.name.replace(/\.[^.]+$/, "").replace(/[^A-Za-z0-9_-]+/g, "_");

  for (let i = 0; i < times.length; i++) {
    await seek(v, times[i]);
    cx.drawImage(v, 0, 0, W, H);
    const blob = await new Promise<Blob | null>((r) => c.toBlob(r, "image/jpeg", 0.92));
    if (!blob) continue;
    const name = `${base}_${String(i).padStart(5, "0")}.jpg`;
    await onFrame({ id: uid("i"), name, w: W, h: H, blob }, i + 1, times.length);
  }
}
