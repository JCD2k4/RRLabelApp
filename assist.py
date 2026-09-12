"""Live-learning assistant for the MASKER annotator.

    python assist.py                # listens on 127.0.0.1:8778; the app reaches it via /assist/*
    python assist.py --device cpu

Every frame you leave in the annotator is sent here. A Mask R-CNN keeps
fine-tuning on everything you have annotated so far, and proposes boxes / masks
for the frame you open next. Nothing is ever added to your annotations without
you accepting it in the app.

Needs torch, torchvision, numpy and Pillow — the same as train_example.py.
The model is checkpointed to assist_model.pt so a restart keeps what it learned.
"""
import argparse, base64, io, json, math, os, random, sys, threading, time, traceback, warnings
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
import torch, torchvision
from PIL import Image, ImageDraw, ImageOps
from torchvision.models.detection.faster_rcnn import FastRCNNPredictor
from torchvision.models.detection.mask_rcnn import MaskRCNNPredictor

HERE = os.path.dirname(os.path.abspath(__file__))
STORE_SIDE = 1024     # frames are kept at most this big on their long side
MIN_FRAMES = 3        # annotated frames needed before anything is suggested
MIN_STEPS = 20
BUDGET_CAP = 400      # most training steps ever queued up
MIN_SCORE = 0.25      # the app filters further with its own slider
LR = 5e-3


# ------------------------------------------------------------------ helpers
def wsl_driver_fix():
    """WSL gets its GPU driver from Windows. If a Linux NVIDIA driver package
    (libnvidia-compute-*) is installed as well, the WSL driver picks up that
    package's PTX JIT compiler and segfaults on the first CUDA call. Loading the
    compiler that ships with the Windows driver first makes every later lookup
    resolve to it."""
    if not os.path.isdir("/usr/lib/wsl/drivers"):
        return
    try:
        import ctypes, re
        ctypes.CDLL("libcuda.so.1").cuInit(0)           # maps the real driver library
        m = re.search(r"(/usr/lib/wsl/drivers/[^/\s]+)/libcuda\.so", open("/proc/self/maps").read())
        jit = m and os.path.join(m.group(1), "libnvidia-ptxjitcompiler.so.1")
        if jit and os.path.exists(jit):
            ctypes.CDLL(jit, mode=ctypes.RTLD_GLOBAL)
    except Exception:
        pass                                            # no GPU here; CPU it is


def pick_device(want):
    if want == "cpu":
        return torch.device("cpu"), ""
    wsl_driver_fix()
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        if not torch.cuda.is_available():
            return torch.device("cpu"), ""
        try:
            (torch.ones(1, device="cuda") * 2).item()
            return torch.device("cuda"), ""
        except Exception:
            name = torch.cuda.get_device_name(0)
    print(f"! {name} is not supported by this PyTorch build ({torch.__version__}); training on CPU.\n"
          "  For newer GPUs install a matching wheel, e.g.\n"
          "    pip install -U torch torchvision --index-url https://download.pytorch.org/whl/cu132")
    return torch.device("cpu"), f"{name} unsupported by this PyTorch — running on CPU (see assist.py console)"


def decode(b64):
    # browsers honour EXIF rotation, so do the same or the shapes land sideways
    img = ImageOps.exif_transpose(Image.open(io.BytesIO(base64.b64decode(b64)))).convert("RGB")
    k = min(1.0, STORE_SIDE / max(img.size))
    if k < 1:
        img = img.resize((max(1, round(img.width * k)), max(1, round(img.height * k))), Image.BILINEAR)
    return img


def to_tensor(img):
    return torch.from_numpy(np.asarray(img).copy()).permute(2, 0, 1).contiguous()   # uint8 [3,H,W]


def rasterize(shapes, w, h):
    boxes, labels, masks = [], [], []
    for s in shapes:
        xs = [p[0] for p in s["pts"]]
        ys = [p[1] for p in s["pts"]]
        x0, y0, x1, y1 = max(0, min(xs)), max(0, min(ys)), min(w, max(xs)), min(h, max(ys))
        if x1 - x0 < 2 or y1 - y0 < 2:
            continue
        poly = [(x0, y0), (x1, y0), (x1, y1), (x0, y1)] if s["type"] == "box" else [tuple(p) for p in s["pts"]]
        m = Image.new("L", (w, h), 0)
        ImageDraw.Draw(m).polygon(poly, fill=1)
        boxes.append([x0, y0, x1, y1])
        labels.append(s["label"])
        masks.append(np.asarray(m, dtype=np.uint8))
    return {
        "boxes": torch.tensor(boxes, dtype=torch.float32).reshape(-1, 4),
        "labels": torch.tensor(labels, dtype=torch.int64),
        "masks": torch.from_numpy(np.stack(masks)) if masks else torch.zeros((0, h, w), dtype=torch.uint8),
    }


def largest_component(m):
    h, w = m.shape
    grid = m.tolist()
    lab = [[0] * w for _ in range(h)]
    best, best_n, cur = 0, 0, 0
    for y, x in zip(*np.nonzero(m)):
        if lab[y][x]:
            continue
        cur += 1
        n, q = 0, [(int(y), int(x))]
        lab[y][x] = cur
        while q:
            cy, cx = q.pop()
            n += 1
            for ny, nx in ((cy - 1, cx), (cy + 1, cx), (cy, cx - 1), (cy, cx + 1)):
                if 0 <= ny < h and 0 <= nx < w and grid[ny][nx] and not lab[ny][nx]:
                    lab[ny][nx] = cur
                    q.append((ny, nx))
        if n > best_n:
            best, best_n = cur, n
    return (np.array(lab) == best) if best_n else None


# 8 neighbours, clockwise with y pointing down, starting west
RING = [(0, -1), (-1, -1), (-1, 0), (-1, 1), (0, 1), (1, 1), (1, 0), (1, -1)]


def trace(m):
    """Moore-neighbour trace of the outer boundary of a single blob (zero-padded)."""
    ys, xs = np.nonzero(m)
    if not len(ys):
        return []
    p, back = (int(ys[0]), int(xs[0])), 0          # topmost-leftmost pixel; west of it is empty
    seen, out = {}, []
    for _ in range(8 * m.size):
        state = (p, back)
        if state in seen:
            return out[seen[state]:]
        seen[state] = len(out)
        out.append(p)
        for k in range(1, 9):
            d = (back + k) % 8
            n = (p[0] + RING[d][0], p[1] + RING[d][1])
            if m[n]:
                prev = (back + k - 1) % 8
                b = (p[0] + RING[prev][0], p[1] + RING[prev][1])
                back = RING.index((b[0] - n[0], b[1] - n[1]))
                p = n
                break
        else:
            return out                                 # a lone pixel
    return out


def simplify(pts, eps):
    """Ramer–Douglas–Peucker, iterative."""
    if len(pts) < 4:
        return pts
    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        a, b = stack.pop()
        (ay, ax), (by, bx) = pts[a], pts[b]
        dy, dx = by - ay, bx - ax
        L = math.hypot(dx, dy)
        best, bi = -1.0, -1
        for i in range(a + 1, b):
            py, px = pts[i]
            d = abs(dx * (ay - py) - dy * (ax - px)) / L if L else math.hypot(px - ax, py - ay)
            if d > best:
                best, bi = d, i
        if best > eps:
            keep[bi] = True
            stack += [(a, bi), (bi, b)]
    return [p for p, k in zip(pts, keep) if k]


def mask_to_poly(prob, x0, y0, side=160, eps=1.0):
    """Probability crop -> polygon (in the crop's parent coordinates), or None."""
    h, w = prob.shape
    if h < 3 or w < 3:
        return None
    k = min(1.0, side / max(h, w))
    im = Image.fromarray((prob * 255).astype(np.uint8))
    if k < 1:
        im = im.resize((max(3, round(w * k)), max(3, round(h * k))), Image.BILINEAR)
    m = np.asarray(im) >= 128
    m = largest_component(m)
    if m is None:
        return None
    fx, fy = w / m.shape[1], h / m.shape[0]
    ring = simplify(trace(np.pad(m, 1)), eps)
    if len(ring) < 3:
        return None
    return [(x0 + (x - 0.5) * fx, y0 + (y - 0.5) * fy) for y, x in ring]


def resize_heads(model, n, keep):
    """Give the heads n outputs (background included), carrying over the first `keep` rows."""
    rh = model.roi_heads
    ob, om = rh.box_predictor, rh.mask_predictor
    nb = FastRCNNPredictor(ob.cls_score.in_features, n)
    nm = MaskRCNNPredictor(om.conv5_mask.in_channels, om.conv5_mask.out_channels, n)
    with torch.no_grad():
        k = min(keep, n, ob.cls_score.out_features)
        nb.cls_score.weight[:k] = ob.cls_score.weight[:k]
        nb.cls_score.bias[:k] = ob.cls_score.bias[:k]
        nb.bbox_pred.weight[:4 * k] = ob.bbox_pred.weight[:4 * k]
        nb.bbox_pred.bias[:4 * k] = ob.bbox_pred.bias[:4 * k]
        nm.conv5_mask.load_state_dict(om.conv5_mask.state_dict())
        nm.mask_fcn_logits.weight[:k] = om.mask_fcn_logits.weight[:k]
        nm.mask_fcn_logits.bias[:k] = om.mask_fcn_logits.bias[:k]
    dev = ob.cls_score.weight.device
    rh.box_predictor, rh.mask_predictor = nb.to(dev), nm.to(dev)


class Sample:
    __slots__ = ("img", "shapes", "sig")

    def __init__(self, img, shapes, sig):
        self.img, self.shapes, self.sig = img, shapes, sig


# ---------------------------------------------------------------- assistant
class Assistant:
    def __init__(self, dev, ckpt, note):
        self.dev, self.ckpt, self.note = dev, ckpt, note
        gpu = dev.type == "cuda"
        self.per_learn = 30 if gpu else 6          # steps queued per frame you finish
        self.size = (640, 1024) if gpu else (512, 800)
        self.batch = 2

        self.model_lock = threading.Lock()         # the model and optimiser
        self.data_lock = threading.Lock()          # everything else
        self.wake = threading.Event()
        self.waiting = 0                           # predictions queued behind a training step

        self._fresh()
        self._load()
        threading.Thread(target=self._train_loop, daemon=True).start()

    # ---- model
    def _fresh(self):
        m = torchvision.models.detection.maskrcnn_resnet50_fpn(
            weights="DEFAULT", min_size=self.size[0], max_size=self.size[1], box_detections_per_img=50)
        resize_heads(m, 1, keep=1)                 # background only until classes arrive
        self.model = m.to(self.dev).train()
        self.classes = []                          # append-only; label = index + 1
        self.samples = {}                          # item id -> Sample
        self.recent = deque(maxlen=4)
        self.budget = self.steps = 0
        self.learns = self.dups = 0
        self.loss = None
        self.restored = False
        self._new_opt()

    def _new_opt(self):
        self.params = [p for p in self.model.parameters() if p.requires_grad]
        self.opt = torch.optim.SGD(self.params, lr=LR, momentum=0.9, weight_decay=1e-4)

    def _load(self):
        if not os.path.exists(self.ckpt):
            return
        try:
            ck = torch.load(self.ckpt, map_location=self.dev, weights_only=True)
            resize_heads(self.model, len(ck["classes"]) + 1, keep=1)
            self.model.load_state_dict(ck["model"])
            self.classes, self.steps = list(ck["classes"]), int(ck.get("steps", 0))
            self.restored = True
            self._new_opt()
            print(f"restored {self.ckpt} · {self.steps} steps · classes {self.classes}")
        except Exception as e:
            print(f"! could not restore {self.ckpt} ({e}); starting fresh")
            self._fresh()

    def save(self):
        with self.model_lock:
            tmp = self.ckpt + ".tmp"
            torch.save({"model": self.model.state_dict(), "classes": self.classes, "steps": self.steps}, tmp)
            os.replace(tmp, self.ckpt)

    def _labels(self, names):
        new = [n for n in dict.fromkeys(names) if n not in self.classes]
        if new:
            with self.model_lock:
                keep = len(self.classes) + 1
                self.classes += new
                resize_heads(self.model, len(self.classes) + 1, keep)
                self._new_opt()
        return {n: self.classes.index(n) + 1 for n in names}

    # ---- training
    def _train_loop(self):
        while True:
            self.wake.wait()
            with self.data_lock:
                if self.budget <= 0 or not self.samples:
                    self.wake.clear()
                    continue
                self.budget -= 1
                ids = list(self.samples)
                recent = [i for i in self.recent if i in self.samples]
                # the frame you just finished gets extra attention; the rest is replay
                pick = [random.choice(recent)] if recent and random.random() < 0.5 else []
                pick += random.sample(ids, min(len(ids), self.batch - len(pick)))
                batch = [self.samples[i] for i in pick]
            while self.waiting:
                time.sleep(0.005)
            try:
                with self.model_lock:
                    loss = self._step(batch)
            except Exception:
                traceback.print_exc()
                continue
            if loss is not None:
                self.steps += 1
                self.loss = loss if self.loss is None else 0.9 * self.loss + 0.1 * loss
                if self.steps % 25 == 0:
                    print(f"step {self.steps} · loss {self.loss:.3f} · {len(self.samples)} frames · {self.budget} queued")
                if self.steps % 200 == 0:
                    self.save()

    def _step(self, batch):
        imgs, targets = [], []
        for s in batch:
            x = s.img.to(self.dev).float().div_(255)
            x = (x * random.uniform(0.8, 1.2) + random.uniform(-0.08, 0.08)).clamp_(0, 1)
            imgs.append(x)
            targets.append({k: v.to(self.dev) for k, v in rasterize(s.shapes, x.shape[2], x.shape[1]).items()})
        for g in self.opt.param_groups:
            g["lr"] = LR * min(1.0, (self.steps + 1) / 50)      # warm up the fresh heads
        loss = sum(self.model(imgs, targets).values())
        self.opt.zero_grad()
        if not torch.isfinite(loss):
            return None
        loss.backward()
        torch.nn.utils.clip_grad_norm_(self.params, 10.0)
        self.opt.step()
        return loss.item()

    def _ready(self):
        return self.steps >= MIN_STEPS and bool(self.classes) and (len(self.samples) >= MIN_FRAMES or self.restored)

    # ---- endpoints
    def status(self, _=None):
        with self.data_lock:
            return {
                "device": str(self.dev), "note": self.note, "classes": self.classes,
                "samples": {k: s.sig for k, s in self.samples.items()},
                "steps": self.steps, "loss": self.loss, "training": self.budget > 0,
                "learns": self.learns, "dups": self.dups,
                "ready": self._ready(), "min_frames": MIN_FRAMES,
            }

    def learn(self, req):
        with self.data_lock:
            have = self.samples.get(req["id"])
            if have is not None and have.sig == req["sig"]:
                # already holds exactly these shapes: re-training on them would just
                # burn GPU and overfit, however often the app offers them
                self.dups += 1
                return {"ok": True, "dup": True}
        img = decode(req["image"])
        sx, sy = img.width / req["w"], img.height / req["h"]
        ids = self._labels([s["cls"] for s in req["shapes"]])
        shapes = [{"label": ids[s["cls"]], "type": s["type"], "pts": [(x * sx, y * sy) for x, y in s["pts"]]}
                  for s in req["shapes"]]
        with self.data_lock:
            self.samples[req["id"]] = Sample(to_tensor(img), shapes, req["sig"])
            if req["id"] in self.recent:
                self.recent.remove(req["id"])
            self.recent.append(req["id"])
            self.budget = min(BUDGET_CAP, self.budget + self.per_learn)
            self.learns += 1
            self.wake.set()

    def forget(self, req):
        with self.data_lock:
            self.samples.pop(req["id"], None)

    def reset(self, _=None):
        with self.model_lock, self.data_lock:
            self._fresh()
            if os.path.exists(self.ckpt):
                os.remove(self.ckpt)
        print("model reset")

    def predict(self, req):
        if not self._ready():
            return {"ready": False, "dets": []}
        img = decode(req["image"])
        sx, sy = img.width / req["w"], img.height / req["h"]
        x = to_tensor(img).to(self.dev).float().div_(255)
        with self.data_lock:
            self.waiting += 1
        try:
            with self.model_lock:
                self.model.eval()
                try:
                    with torch.no_grad():
                        out = self.model([x])[0]
                finally:
                    self.model.train()
                classes = list(self.classes)
        finally:
            with self.data_lock:
                self.waiting -= 1

        dets = []
        H, W = x.shape[1:]
        for i in torch.nonzero(out["scores"] >= MIN_SCORE).flatten().tolist()[:30]:
            x0, y0, x1, y1 = out["boxes"][i].tolist()
            label = int(out["labels"][i])
            if not 0 < label <= len(classes):
                continue
            c0, r0 = max(0, int(x0)), max(0, int(y0))
            c1, r1 = min(W, math.ceil(x1)), min(H, math.ceil(y1))
            poly = mask_to_poly(out["masks"][i, 0, r0:r1, c0:c1].cpu().numpy(), c0, r0)
            dets.append({
                "cls": classes[label - 1],
                "score": round(float(out["scores"][i]), 3),
                "box": [x0 / sx, y0 / sy, x1 / sx, y1 / sy],
                "poly": [[round(px / sx, 1), round(py / sy, 1)] for px, py in poly] if poly else None,
            })
        return {"ready": True, "dets": dets}


# -------------------------------------------------------------------- http
def serve(assist, host, port):
    hello = lambda _=None: {"ok": True, "message": "MASKER assist is running. It only talks to the annotator — "
                                                   "open the app (npm run dev → http://localhost:8777)."}
    routes_get = {"/": hello, "/status": assist.status}
    routes_post = {"/learn": assist.learn, "/predict": assist.predict, "/forget": assist.forget, "/reset": assist.reset}

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def reply(self, code, obj):
            body = json.dumps(obj).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def body(self):
            if self.headers.get("Transfer-Encoding", "").lower() == "chunked":
                data = b""
                while True:
                    n = int(self.rfile.readline().strip(), 16)
                    if not n:
                        self.rfile.readline()
                        return data
                    data += self.rfile.read(n)
                    self.rfile.readline()
            return self.rfile.read(int(self.headers.get("Content-Length") or 0))

        def handle_route(self, routes, req):
            fn = routes.get(self.path.split("?")[0])
            if not fn:
                return self.reply(404, {"error": "not found"})
            try:
                self.reply(200, fn(req) or {"ok": True})
            except Exception as e:
                traceback.print_exc()
                self.reply(500, {"error": str(e)})

        def do_GET(self):
            self.handle_route(routes_get, None)

        def do_POST(self):
            self.handle_route(routes_post, json.loads(self.body() or b"{}"))

    ThreadingHTTPServer((host, port), Handler).serve_forever()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8778)
    ap.add_argument("--device", choices=["auto", "cpu", "cuda"], default="auto")
    ap.add_argument("--ckpt", default=os.path.join(HERE, "assist_model.pt"))
    a = ap.parse_args()
    sys.stdout.reconfigure(line_buffering=True)     # progress shows up even when piped to a log

    dev, note = pick_device(a.device)
    print(f"loading Mask R-CNN on {dev} …")
    assist = Assistant(dev, a.ckpt, note)
    print(f"assist ready on {dev} (port {a.port}) — now open the annotator: npm run dev → http://localhost:8777")
    try:
        serve(assist, a.host, a.port)
    except KeyboardInterrupt:
        if assist.steps:
            assist.save()
            print(f"saved {a.ckpt}")


if __name__ == "__main__":
    main()
