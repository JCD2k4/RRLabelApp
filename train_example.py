"""Finetune torchvision Mask R-CNN on a folder exported by the annotator.

    python train_example.py path/to/exported_dataset --epochs 10

Boxes-only export (no polygons)? Pass --boxes-only to train Faster R-CNN instead.
"""
import argparse, os, torch, torchvision
from torchvision.models.detection.faster_rcnn import FastRCNNPredictor
from torchvision.models.detection.mask_rcnn import MaskRCNNPredictor
from torch.utils.data import DataLoader

from dataset import MaskerDataset, collate


def build(num_classes, boxes_only):
    if boxes_only:
        m = torchvision.models.detection.fasterrcnn_resnet50_fpn(weights="DEFAULT")
    else:
        m = torchvision.models.detection.maskrcnn_resnet50_fpn(weights="DEFAULT")
    inf = m.roi_heads.box_predictor.cls_score.in_features
    m.roi_heads.box_predictor = FastRCNNPredictor(inf, num_classes)
    if not boxes_only:
        inm = m.roi_heads.mask_predictor.conv5_mask.in_channels
        m.roi_heads.mask_predictor = MaskRCNNPredictor(inm, 256, num_classes)
    return m


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("root")
    ap.add_argument("--epochs", type=int, default=10)
    ap.add_argument("--batch", type=int, default=2)
    ap.add_argument("--lr", type=float, default=5e-3)
    ap.add_argument("--boxes-only", action="store_true")
    ap.add_argument("--out", default="model.pt")
    a = ap.parse_args()

    dev = "cuda" if torch.cuda.is_available() else "cpu"
    train = MaskerDataset(a.root, split="train")
    val = MaskerDataset(a.root, split="val")
    print(f"{len(train)} train / {len(val)} val · classes: {train.classes} · device: {dev}")

    dl = DataLoader(train, batch_size=a.batch, shuffle=True, collate_fn=collate, num_workers=2)
    model = build(len(train.classes) + 1, a.boxes_only).to(dev)   # +1 for background
    opt = torch.optim.SGD([p for p in model.parameters() if p.requires_grad],
                          lr=a.lr, momentum=0.9, weight_decay=5e-4)
    sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, a.epochs)

    model.train()
    for ep in range(a.epochs):
        total = 0.0
        for imgs, targets in dl:
            imgs = [i.to(dev) for i in imgs]
            targets = [{k: v.to(dev) for k, v in t.items()} for t in targets]
            if a.boxes_only:
                targets = [{k: v for k, v in t.items() if k != "masks"} for t in targets]
            loss = sum(model(imgs, targets).values())
            opt.zero_grad(); loss.backward(); opt.step()
            total += loss.item()
        sched.step()
        print(f"epoch {ep+1}/{a.epochs}  loss {total/max(1,len(dl)):.4f}")

    torch.save({"model": model.state_dict(), "classes": train.classes}, a.out)
    print("saved", a.out)


if __name__ == "__main__":
    main()
