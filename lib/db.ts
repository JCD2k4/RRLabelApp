"use client";

import { PALETTE, uid, type Anns, type Cls, type Item } from "./types";

/**
 * Everything lives in IndexedDB so a refresh never costs you work.
 * Browsers block storage on file:// URLs, but `next dev` serves over http,
 * so this is always available in practice.
 *
 * v2 keeps several projects side by side: a project owns its classes,
 * annotations and frame order, and every frame records which project it is in.
 */
const DB_NAME = "robotics_mask";
const VERSION = 2;
const ITEMS = "items";
const META = "meta";
const PROJECTS = "projects";

/** A clip this project has already been given, so it is not split twice. */
export interface VideoSource {
  name: string;
  frames: number;
  added: number;
}

export interface Project {
  id: string;
  name: string;
  created: number;
  updated: number;
  classes: Cls[];
  anns: Anns;
  order: string[];
  /** Split clips by content id. Absent on projects stored before this existed. */
  videos?: Record<string, VideoSource>;
}

interface StoredItem extends Item {
  proj: string;
}

/** The project a v1 database turns into — stable, so it can be recognised later. */
export const MIGRATED = "p_migrated";

let dbp: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = (e) => {
      const d = req.result;
      const tx = req.transaction!;
      if (!d.objectStoreNames.contains(ITEMS)) d.createObjectStore(ITEMS, { keyPath: "id" });
      if (!d.objectStoreNames.contains(META)) d.createObjectStore(META, { keyPath: "k" });
      if (!d.objectStoreNames.contains(PROJECTS)) d.createObjectStore(PROJECTS, { keyPath: "id" });
      const items = tx.objectStore(ITEMS);
      if (!items.indexNames.contains("proj")) items.createIndex("proj", "proj");
      if (e.oldVersion > 0 && e.oldVersion < 2) migrate(tx);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

/** v1 held one nameless project inside meta; lift it into the projects store. */
function migrate(tx: IDBTransaction) {
  const meta = tx.objectStore(META);
  const req = meta.get("meta");
  req.onsuccess = () => {
    const old = req.result as { proj?: string; classes?: Cls[]; anns?: Anns; order?: string[] } | undefined;
    if (!old) return;
    const now = Date.now();
    const p: Project = {
      id: MIGRATED,
      name: old.proj || "dataset",
      created: now,
      updated: now,
      classes: old.classes?.length ? old.classes : [{ name: "object", color: PALETTE[0] }],
      anns: old.anns ?? {},
      order: old.order ?? [],
    };
    tx.objectStore(PROJECTS).put(p);
    meta.put({ k: "meta", current: MIGRATED });
    const cur = tx.objectStore(ITEMS).openCursor();
    cur.onsuccess = () => {
      const c = cur.result;
      if (!c) return;
      const v = c.value as StoredItem;
      if (!v.proj) c.update({ ...v, proj: MIGRATED });
      c.continue();
    };
  };
}

async function store(name: string, mode: IDBTransactionMode) {
  return (await open()).transaction(name, mode).objectStore(name);
}

const wrap = <T,>(req: IDBRequest<T>) =>
  new Promise<T>((res, rej) => {
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });

const done = (tx: IDBTransaction) =>
  new Promise<void>((res, rej) => {
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });

/* ------------------------------------------------------------- projects */
export function blankProject(name: string): Project {
  const now = Date.now();
  return {
    id: uid("p"),
    name,
    created: now,
    updated: now,
    classes: [{ name: "object", color: PALETTE[0] }],
    anns: {},
    order: [],
    videos: {},
  };
}

export async function listProjects(): Promise<Project[]> {
  const all = await wrap((await store(PROJECTS, "readonly")).getAll() as IDBRequest<Project[]>);
  return all.sort((a, b) => b.updated - a.updated);
}

export async function getProject(id: string): Promise<Project | undefined> {
  return wrap((await store(PROJECTS, "readonly")).get(id) as IDBRequest<Project | undefined>);
}

export async function saveProject(p: Project) {
  (await store(PROJECTS, "readwrite")).put({ ...p, updated: Date.now() });
}

export async function deleteProject(id: string) {
  const tx = (await open()).transaction([PROJECTS, ITEMS], "readwrite");
  tx.objectStore(PROJECTS).delete(id);
  const cur = tx.objectStore(ITEMS).index("proj").openCursor(IDBKeyRange.only(id));
  cur.onsuccess = () => {
    const c = cur.result;
    if (!c) return;
    c.delete();
    c.continue();
  };
  await done(tx);
}

export async function current(): Promise<string | undefined> {
  const m = await wrap((await store(META, "readonly")).get("meta") as IDBRequest<{ current?: string } | undefined>);
  return m?.current;
}

export async function setCurrent(id: string) {
  (await store(META, "readwrite")).put({ k: "meta", current: id });
}

/* ---------------------------------------------------------------- items */
export async function putItem(it: Item, proj: string) {
  (await store(ITEMS, "readwrite")).put({ ...it, proj } satisfies StoredItem);
}

/** Many frames at once; an import or a backfill would otherwise open a
 *  transaction per frame. */
export async function putItems(its: Item[], proj: string) {
  if (!its.length) return;
  const tx = (await open()).transaction(ITEMS, "readwrite");
  const os = tx.objectStore(ITEMS);
  for (const it of its) os.put({ ...it, proj } satisfies StoredItem);
  await done(tx);
}

export async function deleteItem(id: string) {
  (await store(ITEMS, "readwrite")).delete(id);
}

export async function loadItems(proj: string, order: string[]): Promise<Item[]> {
  const all = await wrap(
    (await store(ITEMS, "readonly")).index("proj").getAll(IDBKeyRange.only(proj)) as IDBRequest<StoredItem[]>,
  );
  const rank = (id: string) => {
    const i = order.indexOf(id);
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  return all.sort((a, b) => rank(a.id) - rank(b.id));
}

/** Everything, every project — the big red button. */
export async function wipeAll() {
  const tx = (await open()).transaction([PROJECTS, ITEMS, META], "readwrite");
  tx.objectStore(PROJECTS).clear();
  tx.objectStore(ITEMS).clear();
  tx.objectStore(META).clear();
  await done(tx);
}
