# An annotator for robotics CV

A small Next.js app. Drop in images or a video, click dots or drag boxes, hit
**Export**, and get a ZIP that a PyTorch `Dataset` reads with no further work.
Everything runs in the browser — no upload, no backend, no API keys — and your
work autosaves to IndexedDB, so a refresh never costs you anything.

## Run it

```bash
npm install
npm run dev          # http://localhost:8777
```

Needs Node 20.9 or newer. There is no backend, no database and no API key to
set up.

For a faster, non-reloading version: `npm run build && npm start`.

## Annotate

| | |
|---|---|
| **+ Images** / **+ Video** | or just drag files onto the page |
| Video | asks for a frame rate, time range and optional resize, then splits it |
| <kbd>B</kbd> | box tool — drag a rectangle |
| <kbd>P</kbd> | mask tool — click dots around the object, <kbd>Enter</kbd> or click the first dot to close |
| <kbd>V</kbd> | select tool — drag a shape to move it, drag a dot to nudge it |
| <kbd>1</kbd>–<kbd>9</kbd> | pick a class (also re-classes whatever is selected) |
| <kbd>A</kbd> / <kbd>D</kbd> | previous / next frame |
| <kbd>C</kbd> | **copy the previous frame's shapes** — the big time saver on video |
| right-click | on a shape deletes it; on a polygon dot deletes that dot |
| <kbd>Ctrl+Z</kbd> · <kbd>Del</kbd> · <kbd>Esc</kbd> | undo · delete selected · cancel |
| wheel · middle-drag / <kbd>space</kbd>-drag · <kbd>F</kbd> | zoom · pan · fit |

Add and rename classes in the right panel; the colour swatch is a colour picker.

Re-adding a file you already have is a no-op, so there is nothing to keep track
of: images are matched on their contents, and dropping a folder twice takes only
what is new — *Added 12 images · skipped 40 already here*. A clip you have already
split asks before splitting again, rather than quietly doubling every frame.
Matching on content and not on filename means a renamed copy is still recognised,
and both checks are per project.

## Projects

The button on the right of the toolbar — **▤ dataset** — opens the project list.
Each project owns its own frames, classes and annotations, so several datasets can
sit side by side in the same browser, and the one you had open comes back on a
refresh.

| | |
|---|---|
| **+ New project** | start an empty one — whatever you have open is saved first |
| ✎ · ✕ | rename · delete a project and its frames |
| **⭱ Import dataset…** | read a `dataset.zip` back in, as a new project |

Import is the reverse of Export: frames, class names and colours, and shapes all
come back from `annotations.json`, with boxes as boxes and dot masks as dot masks.
It also takes a ZIP that has been through a file manager (deflated), COCO from
another tool (`classes.txt` supplies the names; a polygon of more than four points
is read as a mask), or a plain folder of images with no annotations at all. An
import always lands in a project of its own, so nothing is ever overwritten — the
🗑 button is the one that clears *every* project.

## Live suggestions (optional)

With hundreds of frames, let a model learn from you as you go:

```bash
# once: a venv with a CUDA build of PyTorch (cu132 needs an NVIDIA driver for CUDA ≥ 13.2)
python3 -m venv .venv
.venv/bin/pip install torch torchvision --index-url https://download.pytorch.org/whl/cu132
.venv/bin/pip install -r requirements.txt

npm run assist          # = .venv/bin/python assist.py — in a second terminal
```

Leave `npm run dev` running in the first terminal and keep working in
**http://localhost:8777** as usual — the trainer is a background service the page
talks to, so there is nothing to open on its own port. The **Assist** panel in the
right-hand column goes from *offline* to *learning* once it connects.

On WSL, `assist.py` works around a stray Linux NVIDIA driver package
(`libnvidia-compute-*`) that would otherwise crash CUDA; the clean fix is to
remove that package, since WSL gets its driver from Windows.

Every time you leave a frame, its shapes are sent to a Mask R-CNN that keeps
fine-tuning on everything you've annotated (the frame you just finished gets
extra weight; the rest is replayed so it doesn't forget). After a few frames,
the frame you open next shows **dashed suggestions** with a confidence — nothing
is added until you accept it.

| | |
|---|---|
| <kbd>Enter</kbd> | accept every suggestion on the frame |
| click | a suggestion (select tool, or a click-without-drag in box tool) accepts just that one |
| right-click | a suggestion dismisses it |
| <kbd>X</kbd> · <kbd>R</kbd> | dismiss all · ask the model again |

Each frame in the left-hand list carries a dot once the trainer is up: **green** — the
assistant has exactly what you see; **amber** — you have drawn or changed something it
hasn't been given yet. Amber turns green when you leave the frame, which is when the
frame is handed over, so an edit to an old frame is picked up the same way a new one is.
The panel's `step` counter climbing (and `training…`) is the model actually fitting it.

Suggestions come back in the style you use for each class (box, or dot mask), skip
anything you've already drawn, and are filtered by the *min confidence* slider in the
**Assist** panel. The app talks to the trainer through `/assist/*` (a Next rewrite to
`127.0.0.1:8778`; override with `ASSIST_URL`). The model checkpoints to
`assist_model.pt`, and any frames it hasn't seen are re-sent automatically after a
restart. Untick **Assist** to turn it off. A GPU makes it far snappier; on CPU it
takes fewer steps per frame so it still keeps up.

## What Export gives you

```
dataset.zip
├── images/            the frames
├── masks/             PNG per frame, pixel value = class id (0 = background)
├── annotations.json   COCO: bbox [x,y,w,h] + polygon segmentation
├── labels/            YOLO txt (optional tick-box)
├── classes.txt        line N = class id N
├── splits/            train.txt / val.txt
└── dataset.py         the loader below, so the folder is self-contained
```

Boxes are exported as polygons too, so a box and a mask are interchangeable downstream.

## Use it in PyTorch

```python
from dataset import MaskerDataset, collate
from torch.utils.data import DataLoader

ds = MaskerDataset("dataset", split="train", mode="detection")     # boxes + instance masks
dl = DataLoader(ds, batch_size=2, shuffle=True, collate_fn=collate)

x, target = ds[0]        # x: float32 [3,H,W] in 0..1
                         # target: boxes [N,4] xyxy, labels [N], masks [N,H,W] uint8
```

`mode="segmentation"` instead returns `(image, mask)` where mask is an int64 `[H,W]` of
class ids — what `nn.CrossEntropyLoss` wants for a U-Net or DeepLab.

Only `torch`, `torchvision` and `Pillow` are needed; no pycocotools.

### Train something immediately

```bash
python train_example.py dataset --epochs 10          # Mask R-CNN finetune
python train_example.py dataset --boxes-only         # Faster R-CNN, boxes only
```

## Layout

```
app/                 Next App Router — layout, page, global CSS
components/          Annotator (state + keyboard), Canvas (drawing + editing),
                     Toolbar, FrameList, ClassPanel, ShapePanel, AssistPanel,
                     dialogs (Project, Video, Export)
lib/                 types · geom · db (IndexedDB, one record per project)
                     hash (content ids, so nothing is added twice)
                     video (frame extraction) · zip / unzip (no dependencies)
                     exportDataset · importDataset (a dataset ZIP back in)
                     assist (trainer client) · useAssist (teach / suggest loop)
dataset.py           canonical PyTorch loader — synced into public/ on dev/build
                     so it ships inside every export
assist.py            the optional live-learning trainer behind /assist/*
train_example.py     torchvision finetuning script
requirements.txt     python deps for the two scripts above
```

The page is a client component and prerenders to static HTML, so `npm start` needs
no server work at runtime — `next build && next start` is only serving files (plus
passing `/assist/*` through to the trainer, if you run one).

## License

MIT — see [LICENSE](LICENSE). Do what you like with it.
