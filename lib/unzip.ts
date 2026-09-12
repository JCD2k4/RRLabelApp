"use client";

/**
 * Minimal ZIP reader — the mirror of lib/zip.ts.
 *
 * Our own exports are stored uncompressed, but a ZIP that has been through a
 * file manager (or came from another tool) is usually deflated, so entries are
 * inflated with the browser's own DecompressionStream. No dependencies.
 */
const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Paths (as written in the archive) mapped to their bytes. */
export async function unzip(buf: ArrayBuffer): Promise<Map<string, Uint8Array>> {
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);

  // the end-of-central-directory record sits last, after an optional comment
  let end = -1;
  for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 22 - 0xffff); i--) {
    if (dv.getUint32(i, true) === EOCD) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error("Not a ZIP file");

  const count = dv.getUint16(end + 10, true);
  let at = dv.getUint32(end + 16, true);
  if (at === 0xffffffff || count === 0xffff) throw new Error("ZIP64 archives are not supported");

  const dec = new TextDecoder();
  const out = new Map<string, Uint8Array>();

  for (let n = 0; n < count; n++) {
    if (dv.getUint32(at, true) !== CENTRAL) throw new Error("Damaged ZIP directory");
    const method = dv.getUint16(at + 10, true);
    const compSize = dv.getUint32(at + 20, true);
    const nameLen = dv.getUint16(at + 28, true);
    const extraLen = dv.getUint16(at + 30, true);
    const commentLen = dv.getUint16(at + 32, true);
    const local = dv.getUint32(at + 42, true);
    const name = dec.decode(u8.subarray(at + 46, at + 46 + nameLen));
    at += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith("/")) continue;                       // a directory entry
    if (dv.getUint32(local, true) !== LOCAL) throw new Error(`Damaged entry: ${name}`);
    // the local header repeats the name, and its extra field may differ from the central one
    const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
    const raw = u8.subarray(start, start + compSize);
    if (method === 0) out.set(name, raw);
    else if (method === 8) out.set(name, await inflateRaw(raw));
    else throw new Error(`Unsupported compression in ${name}`);
  }
  return out;
}
