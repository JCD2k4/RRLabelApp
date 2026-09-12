// Keeps public/dataset.py in step with the canonical loader at the repo root,
// so every exported ZIP ships the same file you train with.
import { copyFileSync, mkdirSync } from "node:fs";
mkdirSync("public", { recursive: true });
copyFileSync("dataset.py", "public/dataset.py");
