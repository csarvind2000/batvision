"""
nnU-Net trainers for AGB-Net (design rationale lives in agbnet_arch.py).

    nnUNetv2_train 602 3d_fullres 0 -tr nnUNetTrainerAGBNet -p nnUNetResEncUNetMPlans

Ablation trainers isolate every claimed contribution:
    nnUNetTrainerAGBNet_noFiLM / _noBSF / _noTSR / _noBBD / _noBWCE
    nnUNetTrainerAGBNet_backboneOnly   -- ResEnc + baseline loss, the control arm
"""
import pydoc
from typing import List, Tuple, Union

import numpy as np
import torch
import torch.nn as nn

from nnunetv2.training.loss.deep_supervision import DeepSupervisionWrapper
from nnunetv2.training.nnUNetTrainer.nnUNetTrainer import nnUNetTrainer

try:                                                  # loaded as part of the nnunetv2 package
    from nnunetv2.training.nnUNetTrainer.agbnet_arch import AGBNet
    from nnunetv2.training.nnUNetTrainer.agbnet_losses import AGBLoss, SharedContext
except ImportError:                                   # loaded standalone (tests, notebooks)
    from agbnet_arch import AGBNet
    from agbnet_losses import AGBLoss, SharedContext


class nnUNetTrainerAGBNet(nnUNetTrainer):
    # ---- AGB-Net switches (flipped by the ablation subclasses) --------------
    use_film = True
    use_bsf = True
    use_tsr = True
    n_coord_channels = 3
    bsf_stages = (2, 3)
    tsr_width = 32
    tsr_dilations = (1, 2, 3)
    # ---- loss weights ------------------------------------------------------
    w_dice, w_topk, w_bce, w_bbd = 1.0, 1.0, 0.5, 0.5
    boundary_weight = 3.0
    topk = 10
    # Foreground is ~0.25 % of voxels and batch size is 2, so a patch pair can
    # easily contain almost no BAT. Pooling Dice over the batch avoids the
    # degenerate per-sample denominators that causes. The plans file says False;
    # this is a deliberate override for a sparse target.
    batch_dice = True
    # ---- schedule ----------------------------------------------------------
    # 500 to match the baseline trainer exactly (it sets num_epochs = 500 despite
    # its name), so a Dice difference is attributable to the architecture and not
    # to a longer schedule. ~125 s/epoch on a 3080 Ti => ~17 h per fold.
    num_epochs_override = 500
    oversample_fg = 0.33
    # bridge between network.forward (writes the mid-sagittal plane) and the
    # bilateral loss (reads it). Class-level so the classmethod builder sees it.
    _ctx = None

    def __init__(self, plans, configuration, fold, dataset_json,
                 device: torch.device = torch.device("cuda")):
        super().__init__(plans, configuration, fold, dataset_json, device)
        self.num_epochs = self.num_epochs_override
        self.oversample_foreground_percent = self.oversample_fg
        self.ctx = SharedContext()
        type(self)._ctx = self.ctx

    def _do_i_compile(self):
        # torch.compile does not tolerate the forward-side effect that carries the
        # mid-sagittal plane from the network to the bilateral loss.
        return False

    # nnU-Net calls this both here and, at inference time, on the *class*
    # (nnUNetPredictor.initialize_from_trained_model_folder), hence classmethod.
    @classmethod
    def build_network_architecture(cls,
                                   architecture_class_name: str,
                                   arch_init_kwargs: dict,
                                   arch_init_kwargs_req_import: Union[List[str], Tuple[str, ...]],
                                   num_input_channels: int,
                                   num_output_channels: int,
                                   enable_deep_supervision: bool = True) -> nn.Module:
        kw = dict(arch_init_kwargs)
        for r in arch_init_kwargs_req_import:
            if kw.get(r) is not None:
                kw[r] = pydoc.locate(kw[r])
        for k in ("input_channels", "num_classes", "deep_supervision"):
            kw.pop(k, None)
        return AGBNet(input_channels=num_input_channels,
                      num_classes=num_output_channels,
                      deep_supervision=enable_deep_supervision,
                      n_coord_channels=cls.n_coord_channels,
                      use_film=cls.use_film, use_bsf=cls.use_bsf, use_tsr=cls.use_tsr,
                      bsf_stages=cls.bsf_stages, tsr_width=cls.tsr_width,
                      tsr_dilations=cls.tsr_dilations,
                      ctx=cls._ctx,
                      **kw)

    def initialize(self):
        super().initialize()
        n = sum(p.numel() for p in self.network.parameters() if p.requires_grad) / 1e6
        self.print_to_log_file(
            f"AGB-Net: film={self.use_film} bsf={self.bsf_stages if self.use_bsf else False} "
            f"tsr={self.use_tsr}(w={self.tsr_width},d={self.tsr_dilations}) "
            f"coord_ch={self.n_coord_channels} | loss dice={self.w_dice} topk={self.w_topk} "
            f"bwce={self.w_bce} bbd={self.w_bbd} | epochs={self.num_epochs} "
            f"oversample={self.oversample_foreground_percent} | params={n:.1f} M")

    def _build_loss(self):
        assert not self.label_manager.has_regions, "regions not supported by AGB-Net"
        loss = AGBLoss(self.ctx,
                       num_classes=self.label_manager.num_segmentation_heads,
                       w_dice=self.w_dice, w_topk=self.w_topk,
                       w_bce=self.w_bce, w_bbd=self.w_bbd,
                       topk=self.topk, boundary_weight=self.boundary_weight,
                       batch_dice=self.batch_dice,
                       ignore_label=self.label_manager.ignore_label
                       if self.label_manager.has_ignore_label else None,
                       ddp=self.is_ddp)
        if self.enable_deep_supervision:
            scales = self._get_deep_supervision_scales()
            weights = np.array([1 / (2 ** i) for i in range(len(scales))])
            weights[-1] = 0
            weights = weights / weights.sum()
            loss = DeepSupervisionWrapper(loss, weights)
        return loss


# --------------------------------------------------------------------------- #
#  ablations
# --------------------------------------------------------------------------- #
class nnUNetTrainerAGBNet_noFiLM(nnUNetTrainerAGBNet):
    use_film = False


class nnUNetTrainerAGBNet_noBSF(nnUNetTrainerAGBNet):
    use_bsf = False


class nnUNetTrainerAGBNet_noTSR(nnUNetTrainerAGBNet):
    use_tsr = False


class nnUNetTrainerAGBNet_noBBD(nnUNetTrainerAGBNet):
    w_bbd = 0.0


class nnUNetTrainerAGBNet_noBWCE(nnUNetTrainerAGBNet):
    w_bce = 0.0


class nnUNetTrainerAGBNet_1000ep(nnUNetTrainerAGBNet):
    num_epochs_override = 1000


class nnUNetTrainerAGBNet_backboneOnly(nnUNetTrainerAGBNet):
    """Control arm: ResEnc backbone + the baseline's own loss; the coordinate
    channels are still fed as plain inputs. Separates 'new architecture' from
    'new backbone'."""
    use_film = False
    use_bsf = False
    use_tsr = False
    w_bce = 0.0
    w_bbd = 0.0
