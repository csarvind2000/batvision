import numpy as np
import torch

from nnunetv2.training.loss.compound_losses import DC_and_topk_loss
from nnunetv2.training.loss.deep_supervision import DeepSupervisionWrapper
from nnunetv2.training.loss.robust_ce_loss import TopKLoss

from nnunetv2.training.nnUNetTrainer.nnUNetTrainer import nnUNetTrainer





class nnUNetTrainerTopK10Loss_33os_1000epochs(nnUNetTrainer):
    """
    Custom trainer combining:
    - TopK10 Loss (CE only, no Dice)
    - 66% probabilistic foreground oversampling (very high oversampling)
    - 2000 epochs training

    Use for extreme class imbalance with very sparse foreground.
    """

    def __init__(
        self,
        plans: dict,
        configuration: str,
        fold: int,
        dataset_json: dict,
        device: torch.device = torch.device("cuda"),
    ):
        super().__init__(plans, configuration, fold, dataset_json, device)

        # Set 2000 epochs
        self.num_epochs = 500

        # Set probabilistic oversampling to 99%
        #self.probabilistic_oversampling = True
        self.oversample_foreground_percent = 0.33

        self.print_to_log_file(f"Custom trainer initialized:")
        self.print_to_log_file(f"  - num_epochs: {self.num_epochs}")
        self.print_to_log_file(f"  - probabilistic_oversampling: {self.probabilistic_oversampling}")
        self.print_to_log_file(f"  - oversample_foreground_percent: {self.oversample_foreground_percent}")

    def _build_loss(self):
        """
        Build TopK10 loss (CE only, no Dice component)
        """
        assert not self.label_manager.has_regions, "regions not supported by this trainer"

        loss = TopKLoss(
            ignore_index=self.label_manager.ignore_label if self.label_manager.has_ignore_label else -100,
            k=10,
        )

        if self.enable_deep_supervision:
            deep_supervision_scales = self._get_deep_supervision_scales()

            # we give each output a weight which decreases exponentially (division by 2) as the resolution decreases
            # this gives higher resolution outputs more weight in the loss
            weights = np.array([1 / (2**i) for i in range(len(deep_supervision_scales))])
            weights[-1] = 0

            # we don't use the lowest 2 outputs. Normalize weights so that they sum to 1
            weights = weights / weights.sum()
            # now wrap the loss
            loss = DeepSupervisionWrapper(loss, weights)

        return loss
