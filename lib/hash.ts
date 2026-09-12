"use client";

/**
 * A content id for a file, so the same image or clip is never added twice.
 *
 * SHA-256 where it is available, but `crypto.subtle` only exists in a secure
 * context and this app is meant to be reachable over plain http on a LAN IP
 * (see `allowedDevOrigins` in next.config.mjs), so there is a pure-JS fallback.
 * Either way the byte length is part of the id, which on its own rules out
 * almost every accidental collision.
 *
 * Anything past SAMPLE_OVER is identified by its two ends instead of being read
 * whole: a screen capture can run to gigabytes, and holding one in an
 * ArrayBuffer to hash it would cost far more than the duplicate check saves.
 */
const SAMPLE_OVER = 64 * 1024 * 1024;
const SAMPLE = 4 * 1024 * 1024;

const hex = (u8: Uint8Array) => Array.from(u8, (b) => b.toString(16).padStart(2, "0")).join("");

export async function contentId(blob: Blob): Promise<string> {
  const sampled = blob.size > SAMPLE_OVER;
  const read = sampled
    ? new Blob([blob.slice(0, SAMPLE), blob.slice(blob.size - SAMPLE)])
    : blob;
  const buf = await read.arrayBuffer();
  // the tag keeps a sampled id from ever matching a whole-file one
  const tag = `${sampled ? "s" : "f"}${blob.size}-`;

  const sub = globalThis.crypto?.subtle;
  if (sub) {
    try {
      const d = new Uint8Array(await sub.digest("SHA-256", buf));
      return tag + hex(d.subarray(0, 16));
    } catch {
      /* insecure context or blocked — use the fallback below */
    }
  }
  return tag + jsHash(new Uint8Array(buf));
}

/** Two independent 32-bit mixers, so the fallback still spreads over 64 bits. */
function jsHash(u8: Uint8Array): string {
  let a = 0x811c9dc5;
  let b = 0x9e3779b9;
  for (let i = 0; i < u8.length; i++) {
    a = Math.imul(a ^ u8[i], 0x01000193);
    b = Math.imul(b + u8[i], 0x85ebca6b) ^ (b >>> 15);
  }
  return hex(new Uint8Array([a >>> 24, a >>> 16, a >>> 8, a, b >>> 24, b >>> 16, b >>> 8, b]));
}
