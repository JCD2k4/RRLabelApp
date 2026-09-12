"""PyTorch dataset for folders exported by the MASKER annotator.

    ds = MaskerDataset('.', split='train', mode='detection')     # boxes + instance masks
    ds = MaskerDataset('.', split='train', mode='segmentation')  # semantic mask

Only torch, torchvision and Pillow are required (no pycocotools).
"""
import json, os
import torch
import numpy as np
from PIL import Image, ImageDraw
from torch.utils.data import Dataset


class MaskerDataset(Dataset):
    def __init__(self, root, split=None, mode='detection', transforms=None):
        self.root, self.mode, self.transforms = root, mode, transforms
        with open(os.path.join(root, 'annotations.json')) as f:
            coco = json.load(f)
        self.classes = [c['name'] for c in sorted(coco['categories'], key=lambda c: c['id'])]
        keep = None
        if split:
            p = os.path.join(root, 'splits', split + '.txt')
            if os.path.exists(p):
                keep = {l.strip() for l in open(p) if l.strip()}
        self.images = [im for im in coco['images'] if keep is None or im['file_name'] in keep]
        self.anns = {im['id']: [] for im in coco['images']}
        for a in coco['annotations']:
            self.anns[a['image_id']].append(a)

    def __len__(self):
        return len(self.images)

    def __getitem__(self, i):
        im = self.images[i]
        img = Image.open(os.path.join(self.root, 'images', im['file_name'])).convert('RGB')
        anns = self.anns[im['id']]

        if self.mode == 'segmentation':
            mp = os.path.join(self.root, 'masks', os.path.splitext(im['file_name'])[0] + '.png')
            mask = np.array(Image.open(mp).convert('L'), dtype=np.int64)
            x = torch.from_numpy(np.array(img)).permute(2, 0, 1).float() / 255
            y = torch.from_numpy(mask)
            if self.transforms: x, y = self.transforms(x, y)
            return x, y

        boxes, labels, masks = [], [], []
        for a in anns:
            x, y, w, h = a['bbox']
            if w <= 1 or h <= 1: continue
            boxes.append([x, y, x + w, y + h])
            labels.append(a['category_id'])
            m = Image.new('L', (im['width'], im['height']), 0)
            for poly in a['segmentation']:
                ImageDraw.Draw(m).polygon([tuple(poly[k:k+2]) for k in range(0, len(poly), 2)], fill=1)
            masks.append(np.array(m, dtype=np.uint8))

        target = {
            'boxes': torch.as_tensor(boxes, dtype=torch.float32).reshape(-1, 4),
            'labels': torch.as_tensor(labels, dtype=torch.int64),
            'masks': torch.as_tensor(np.array(masks), dtype=torch.uint8) if masks
                     else torch.zeros((0, im['height'], im['width']), dtype=torch.uint8),
            'image_id': torch.tensor([im['id']]),
        }
        x = torch.from_numpy(np.array(img)).permute(2, 0, 1).float() / 255
        if self.transforms: x, target = self.transforms(x, target)
        return x, target


def collate(batch):
    return tuple(zip(*batch))


if __name__ == '__main__':
    ds = MaskerDataset(os.path.dirname(os.path.abspath(__file__)) or '.')
    print(len(ds), 'images ·', ds.classes)
    x, t = ds[0]
    print(x.shape, {k: tuple(v.shape) for k, v in t.items()})
