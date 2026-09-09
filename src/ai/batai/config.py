"""Configuration for the BATVision inference service.

Every knob is an environment variable so the same image can serve any of the
registered models without a rebuild.  Names follow one scheme:

    BATAI_*                    service level (model choice, paths, device)
    BATAI_<MODEL_KEY>_*        per-model override of a ModelSpec field
    NNUNET_*                   the three directories nnU-Net itself expects

Importing this module also exports ``nnUNet_raw`` / ``nnUNet_preprocessed`` /
``nnUNet_results`` into ``os.environ`` so that ``nnUNetv2_predict`` -- whether it
runs in-process or as a subprocess -- resolves the model folder the same way.
"""
from __future__ import annotations

import os
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Dict, Tuple


def _env(*names: str, default: str = "") -> str:
    """First non-empty value among `names` (earlier names win, later are legacy)."""
    for n in names:
        v = os.environ.get(n)
        if v is not None and v.strip() != "":
            return v.strip()
    return default


def _flag(*names: str, default: bool = False) -> bool:
    v = _env(*names, default=str(default)).lower()
    return v in ("1", "true", "yes", "on")


# --------------------------------------------------------------------------- #
#  nnU-Net directories
# --------------------------------------------------------------------------- #
MODELS_ROOT = Path(_env("BATAI_MODELS_ROOT", default="/models"))

NNUNET_RESULTS = Path(_env("NNUNET_RESULTS_DIR", "nnUNet_results",
                           default=str(MODELS_ROOT / "nnunet_results")))
NNUNET_RAW = Path(_env("NNUNET_RAW_DIR", "nnUNet_raw",
                       default=str(MODELS_ROOT / "nnunet_raw")))
NNUNET_PREPROCESSED = Path(_env("NNUNET_PREPROCESSED_DIR", "nnUNet_preprocessed",
                                default=str(MODELS_ROOT / "nnunet_preprocessed")))

os.environ["nnUNet_results"] = str(NNUNET_RESULTS)
os.environ["nnUNet_raw"] = str(NNUNET_RAW)
os.environ["nnUNet_preprocessed"] = str(NNUNET_PREPROCESSED)


# --------------------------------------------------------------------------- #
#  service level
# --------------------------------------------------------------------------- #
OUT_BASE = Path(_env("BATAI_OUT_BASE", "BAT_OUT_BASE", default="/storage/bat_outputs"))
TMP_DIR = Path(_env("BATAI_TMP_DIR", default="/tmp/batai"))
DEVICE = _env("BATAI_DEVICE", default="cuda").lower()          # cuda | cpu | mps
DISABLE_TTA = _flag("BATAI_DISABLE_TTA", default=False)
KEEP_WORKDIR = _flag("BATAI_KEEP_WORKDIR", "DEBUG_MODE", default=False)
DEBUG = _flag("BATAI_DEBUG", default=False)
HOST = _env("BATAI_HOST", default="0.0.0.0")
PORT = int(_env("BATAI_PORT", default="9000"))


# --------------------------------------------------------------------------- #
#  model registry
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class ModelSpec:
    """Everything needed to turn a (fat, fat-fraction) pair into a BAT mask."""

    key: str                      # registry key, also the env-var prefix
    name: str                     # human readable
    description: str
    dataset_id: int
    configuration: str
    trainer: str
    plans: str
    folds: Tuple[str, ...]
    checkpoint: str = "checkpoint_final.pth"
    # AGB-Net carries three anatomical coordinate ramps as extra input channels
    # (see batai/coords.py); the baseline takes fat + fat-fraction only.
    coord_channels: bool = False
    input_channels: int = 2
    notes: str = ""

    @property
    def model_dir(self) -> Path:
        """The nnU-Net results folder this spec resolves to."""
        parent = NNUNET_RESULTS
        prefix = f"Dataset{self.dataset_id:03d}_"
        matches = sorted(p for p in parent.glob(f"{prefix}*") if p.is_dir())
        dataset_dir = matches[0] if matches else parent / f"Dataset{self.dataset_id:03d}"
        return dataset_dir / f"{self.trainer}__{self.plans}__{self.configuration}"

    def missing_files(self) -> list[str]:
        """Human-readable list of what is not on disk; empty means ready to run."""
        d = self.model_dir
        if not d.is_dir():
            return [str(d)]
        missing = [str(d / f) for f in ("plans.json", "dataset.json")
                   if not (d / f).is_file()]
        missing += [str(d / f"fold_{f}" / self.checkpoint)
                    for f in self.folds
                    if not (d / f"fold_{f}" / self.checkpoint).is_file()]
        return missing

    def is_available(self) -> bool:
        return not self.missing_files()

    def as_dict(self) -> dict:
        return {
            "key": self.key,
            "name": self.name,
            "description": self.description,
            "dataset_id": self.dataset_id,
            "configuration": self.configuration,
            "trainer": self.trainer,
            "plans": self.plans,
            "folds": list(self.folds),
            "checkpoint": self.checkpoint,
            "input_channels": self.input_channels,
            "coord_channels": self.coord_channels,
            "model_dir": str(self.model_dir),
            "available": self.is_available(),
            "notes": self.notes,
        }


_DEFAULTS: Tuple[ModelSpec, ...] = (
    ModelSpec(
        key="agbnet",
        name="AGB-Net",
        description=(
            "Anatomy-Guided Bilateral Network: nnU-Net ResEnc-M backbone plus "
            "ACC-FiLM anatomical coordinate conditioning, Bilateral Symmetry "
            "Fusion and a Thin-Structure Refinement head."
        ),
        dataset_id=602,
        configuration="3d_fullres",
        trainer="nnUNetTrainerAGBNet",
        plans="nnUNetResEncUNetMPlans_AGB",
        folds=("0",),
        checkpoint="checkpoint_best.pth",
        coord_channels=True,
        input_channels=5,
        notes="fold 0, 58-case validation: mean Dice 0.8614 vs 0.8575 baseline.",
    ),
    ModelSpec(
        key="baseline",
        name="nnU-Net TopK10 baseline",
        description=(
            "PlainConvUNet baseline trained with SoftDice + TopK-10 CE on the "
            "longitudinal union dataset. Kept for comparison and fallback."
        ),
        dataset_id=901,
        configuration="3d_fullres",
        trainer="nnUNetTrainerTopK10Loss_33os_1000epochs",
        plans="nnUNetPlans",
        folds=("0",),
        checkpoint="checkpoint_final.pth",
        coord_channels=False,
        input_channels=2,
        notes="fold 0 validation: mean Dice 0.8575.",
    ),
)


def _apply_env_overrides(spec: ModelSpec) -> ModelSpec:
    """`BATAI_AGBNET_FOLDS=0,1` overrides `folds` on the agbnet spec, and so on."""
    p = f"BATAI_{spec.key.upper()}_"
    out = {}
    if v := _env(p + "DATASET_ID"):
        out["dataset_id"] = int(v)
    if v := _env(p + "CONFIG", p + "CONFIGURATION"):
        out["configuration"] = v
    if v := _env(p + "TRAINER"):
        out["trainer"] = v
    if v := _env(p + "PLANS"):
        out["plans"] = v
    if v := _env(p + "FOLDS"):
        out["folds"] = tuple(x.strip() for x in v.split(",") if x.strip())
    if v := _env(p + "CHECKPOINT"):
        out["checkpoint"] = v
    return replace(spec, **out) if out else spec


MODELS: Dict[str, ModelSpec] = {s.key: _apply_env_overrides(s) for s in _DEFAULTS}

DEFAULT_MODEL = _env("BATAI_MODEL", default="agbnet").lower()
if DEFAULT_MODEL not in MODELS:
    raise SystemExit(
        f"BATAI_MODEL={DEFAULT_MODEL!r} is not a registered model. "
        f"Known models: {', '.join(sorted(MODELS))}"
    )


def get_model(key: str | None) -> ModelSpec:
    """Resolve a model key, falling back to the configured default."""
    k = (key or DEFAULT_MODEL).strip().lower()
    if k not in MODELS:
        raise KeyError(f"unknown model {k!r}; known models: {', '.join(sorted(MODELS))}")
    return MODELS[k]
