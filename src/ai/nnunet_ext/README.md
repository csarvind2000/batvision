# `nnunet_ext` — custom nnU-Net trainers

nnU-Net resolves a trainer by class name inside
`site-packages/nnunetv2/training/nnUNetTrainer/`, both when training and when
`nnUNetPredictor` restores a checkpoint. The Docker build therefore copies every
file in this folder into that package directory (see `ai/Dockerfile`), and the
build fails loudly if any of them will not import.

| file | used by |
|---|---|
| `nnUNetTrainerAGBNet.py` | AGB-Net (`Dataset602_BAT_AGB`) — also defines the ablation trainers |
| `agbnet_arch.py` | `AGBNet`, `AnatomicalFiLM`, `BilateralSymmetryFusion`, `ThinStructureRefinement` |
| `agbnet_losses.py` | `AGBLoss`, `BoundaryWeightedCE`, `BilateralBalancedDice`, `SharedContext` |
| `nnUNetTrainerTopK10Loss_33os_1000epochs.py` | the baseline model (`Dataset901_BAT_Longitudinal_UNION_45y_6y`) |

These are copies of the research tree at `BAT/batnet/`. Inference only needs the
architecture (the loss and the training schedule are never executed), but the
trainer module imports both at module scope, so all three AGB-Net files must be
present together.

`batai/coords.py` holds the fourth piece — the anatomical coordinate channels
AGB-Net expects as inputs 2–4. It is a copy of `batnet/make_coord_dataset.py`;
if the coordinate frame changes there, change it in both places or predictions
degrade silently.
