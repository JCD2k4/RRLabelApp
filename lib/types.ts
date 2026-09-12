export type Pt = [number, number];

export type ShapeKind = "box" | "poly";

export interface Shape {
  id: string;
  cls: number;          // index into Cls[]
  type: ShapeKind;
  pts: Pt[];            // image pixel coordinates; a box stores two opposite corners
}

/** A shape the assistant proposes; it only becomes a Shape once you accept it. */
export interface Sugg extends Shape {
  score: number;
}

export interface Item {
  id: string;
  name: string;
  w: number;
  h: number;
  blob: Blob;
  /** Content id (lib/hash) — how a re-added file is recognised. Absent on
   *  frames stored before it existed; filled in when the project is opened. */
  hash?: string;
}

export interface Cls {
  name: string;
  color: string;
}

export type Anns = Record<string, Shape[]>;

export type Tool = "sel" | "box" | "poly";

export const PALETTE = [
  "#ff3b30", "#4c9aff", "#39d353", "#ffb020", "#c77dff",
  "#00d4d4", "#ff7ab6", "#9fe870", "#ff9f0a", "#7aa2ff",
];

let counter = 0;
export const uid = (p = "s") =>
  `${p}${++counter}_${Math.random().toString(36).slice(2, 7)}`;
