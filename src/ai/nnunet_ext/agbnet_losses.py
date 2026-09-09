"""
Losses for AGB-Net, each aimed at a measured error mode of the Dataset601 baseline.

  Soft Dice + TopK-10 CE
      the baseline's own recipe, kept as the stable core.

  Boundary-Weighted CE  (BW-CE)
      72-92 % of every FP and FN voxel lies within 2 mm of the surface, and BAT's
      median half-thickness is exactly one voxel, so the surface band *is* the
      structure.  A 1-voxel shell around the GT boundary is computed on-GPU with
      max-pooling (dilation and erosion) and CE is up-weighted there.

  Bilateral Balanced Dice  (BBD)
      the catastrophic cases are not boundary errors, they are whole missing
      depots (worst case: 10326 FN voxels, nearest prediction 146 mm away).
      Global Dice barely registers the loss of one of two depots.  Because BAT is
      bilateral in 100 % of cases with a median L/R volume ratio of 0.95, we split
      each patch at the subject's own mid-sagittal plane -- recovered by the
      network from the left-right coordinate channel -- and average the Dice of
      the two halves.  Dropping one depot then costs ~0.5 instead of ~0.25, which
      is the gradient the baseline never received.
"""
import torch
import torch.nn as nn
import torch.nn.functional as F

from nnunetv2.training.loss.dice import MemoryEfficientSoftDiceLoss
from nnunetv2.training.loss.robust_ce_loss import TopKLoss

try:
    from nnunetv2.training.nnUNetTrainer.agbnet_arch import signed_distance
except ImportError:
    from agbnet_arch import signed_distance


class SharedContext:
    """Written by the network's forward, read by the loss. One per trainer.

    Carries the subject's mid-sagittal plane (normal, offset, confidence) that
    AGBNet recovers from the left-right coordinate channel, so the bilateral loss
    splits each patch on exactly the same plane the network mirrors about.
    """
    plane_n = None
    plane_c = None
    plane_conf = None


def _boundary_band(target: torch.Tensor, width: int = 1) -> torch.Tensor:
    """1 on a `width`-voxel shell either side of the GT surface, else 0."""
    t = (target > 0).float()
    k = 2 * width + 1
    pool = F.max_pool3d if t.dim() == 5 else F.max_pool2d
    dil = pool(t, kernel_size=k, stride=1, padding=width)
    ero = -pool(-t, kernel_size=k, stride=1, padding=width)
    return (dil - ero).clamp(0, 1)


class BoundaryWeightedCE(nn.Module):
    def __init__(self, boundary_weight: float = 3.0, width: int = 1, ignore_index: int = -100):
        super().__init__()
        self.bw, self.width, self.ignore_index = boundary_weight, width, ignore_index

    def forward(self, logits: torch.Tensor, target: torch.Tensor) -> torch.Tensor:
        tgt = target[:, 0].long() if target.dim() == logits.dim() else target.long()
        ce = F.cross_entropy(logits, tgt, reduction="none", ignore_index=self.ignore_index)
        band = _boundary_band(target.float() if target.dim() == logits.dim()
                              else target.unsqueeze(1).float(), self.width)[:, 0]
        w = 1.0 + (self.bw - 1.0) * band
        valid = (tgt != self.ignore_index).float()
        return (ce * w * valid).sum() / (w * valid).sum().clamp(min=1.0)


class BilateralBalancedDice(nn.Module):
    """Soft Dice computed separately on the two sides of the mid-sagittal plane."""

    def __init__(self, ctx: SharedContext, smooth: float = 1.0):
        super().__init__()
        self.ctx, self.smooth = ctx, smooth

    def _side_masks(self, shape, device):
        n, c, conf = self.ctx.plane_n, self.ctx.plane_c, self.ctx.plane_conf
        if n is None or c is None:
            return None
        d = signed_distance(shape, n.to(device), c.to(device), device)
        left = (d < 0).float()
        return left, 1.0 - left, conf.to(device)

    def forward(self, logits: torch.Tensor, target: torch.Tensor) -> torch.Tensor:
        m = self._side_masks(logits.shape, logits.device)
        if m is None:
            return logits.sum() * 0.0
        left, right, conf = m
        prob = torch.softmax(logits.float(), 1)[:, 1:]                    # foreground channels
        tgt = target[:, 0] if target.dim() == logits.dim() else target
        tgt = F.one_hot(tgt.long().clamp(min=0), logits.shape[1]).permute(
            0, -1, *range(1, tgt.dim())).float()[:, 1:]

        red = tuple(range(2, prob.dim()))
        total, n = 0.0, 0
        for side in (left, right):
            p, t = prob * side, tgt * side
            inter = (p * t).sum(red)
            denom = p.sum(red) + t.sum(red)
            present = (t.sum(red) > 0).float()                            # only score sides with GT
            dice = (2 * inter + self.smooth) / (denom + self.smooth)
            total = total + ((1 - dice) * present).sum(1)
            n = n + present.sum(1).clamp(min=1)
        per_sample = total / n
        c = conf.float()
        return (per_sample * c).sum() / c.sum().clamp(min=1e-6)


class AGBLoss(nn.Module):
    def __init__(self, ctx: SharedContext, num_classes: int,
                 w_dice: float = 1.0, w_topk: float = 1.0,
                 w_bce: float = 0.5, w_bbd: float = 0.5,
                 topk: int = 10, boundary_weight: float = 3.0,
                 batch_dice: bool = True, ignore_label=None, ddp: bool = False):
        super().__init__()
        self.w = dict(dice=w_dice, topk=w_topk, bce=w_bce, bbd=w_bbd)
        ii = ignore_label if ignore_label is not None else -100
        self.dice = MemoryEfficientSoftDiceLoss(batch_dice=batch_dice, do_bg=False,
                                                smooth=1e-5, ddp=ddp,
                                                apply_nonlin=torch.nn.Softmax(dim=1))
        self.topk = TopKLoss(ignore_index=ii, k=topk)
        self.bce = BoundaryWeightedCE(boundary_weight=boundary_weight, ignore_index=ii)
        self.bbd = BilateralBalancedDice(ctx)

    def forward(self, logits, target):
        return (self.w["dice"] * self.dice(logits, target)
                + self.w["topk"] * self.topk(logits, target)
                + self.w["bce"] * self.bce(logits, target)
                + self.w["bbd"] * self.bbd(logits, target))
