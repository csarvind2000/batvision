"""Turn a (fat, fat-fraction) pair into an nnU-Net prediction for a given model."""
from __future__ import annotations

import os
import subprocess
from pathlib import Path

import SimpleITK as sitk

from . import config
from .config import ModelSpec
from .coords import write_coord_channels
from .imaging import read_img, same_geometry, write_img


class PredictError(RuntimeError):
    """nnUNetv2_predict failed, with its stderr attached."""


def build_input_folder(spec: ModelSpec, case_id: str, fat_p: Path, ff_p: Path,
                       flat_dir: Path) -> Path:
    """Lay the case out as nnU-Net expects: ``<case_id>_XXXX.nii.gz`` in one folder.

    The fat volume is symlinked (they are large); the fat-fraction volume is
    symlinked too when it already shares the fat grid and resampled otherwise.
    AGB-Net additionally gets the three anatomical coordinate channels.
    """
    flat_dir = Path(flat_dir)
    flat_dir.mkdir(parents=True, exist_ok=True)

    fat_out = flat_dir / f"{case_id}_0000.nii.gz"
    ff_out = flat_dir / f"{case_id}_0001.nii.gz"
    for p in (fat_out, ff_out):
        if p.exists() or p.is_symlink():
            p.unlink()

    fat_out.symlink_to(fat_p.resolve())

    fat_img = read_img(fat_p)
    ff_img = read_img(ff_p)
    if same_geometry(fat_img, ff_img):
        ff_out.symlink_to(ff_p.resolve())
    else:
        ff_res = sitk.Resample(ff_img, fat_img, sitk.Transform(),
                               sitk.sitkLinear, 0.0, ff_img.GetPixelID())
        write_img(ff_res, ff_out)

    if spec.coord_channels:
        write_coord_channels(case_id, fat_out, ff_out, flat_dir)

    return flat_dir


def predict_command(spec: ModelSpec, input_dir: Path, output_dir: Path) -> list[str]:
    """The exact ``nnUNetv2_predict`` invocation for this model."""
    cmd = [
        "nnUNetv2_predict",
        "-i", str(input_dir),
        "-o", str(output_dir),
        "-d", str(spec.dataset_id),
        "-c", spec.configuration,
        "-tr", spec.trainer,
        "-p", spec.plans,
        "-f", *spec.folds,
        "-chk", spec.checkpoint,
        "-device", config.DEVICE,
    ]
    if config.DISABLE_TTA:
        cmd.append("--disable_tta")
    return cmd


def run_predict(spec: ModelSpec, input_dir: Path, output_dir: Path) -> Path:
    """Run the model and return the path of the predicted label map."""
    missing = spec.missing_files()
    if missing:
        raise PredictError(
            f"model '{spec.key}' is not installed; missing: {', '.join(missing)}. "
            f"Mount the nnU-Net results tree at {config.NNUNET_RESULTS}."
        )

    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    env = dict(os.environ)
    env["nnUNet_results"] = str(config.NNUNET_RESULTS)
    env["nnUNet_raw"] = str(config.NNUNET_RAW)
    env["nnUNet_preprocessed"] = str(config.NNUNET_PREPROCESSED)

    cmd = predict_command(spec, input_dir, output_dir)
    proc = subprocess.run(cmd, env=env, capture_output=True, text=True)
    if proc.returncode != 0:
        tail = (proc.stderr or proc.stdout or "").strip().splitlines()[-40:]
        raise PredictError(
            f"nnUNetv2_predict exited {proc.returncode} for model '{spec.key}':\n"
            + "\n".join(tail)
        )
    return find_prediction(output_dir, spec, input_dir)


def find_prediction(output_dir: Path, spec: ModelSpec, input_dir: Path) -> Path:
    """Locate the single label map nnU-Net wrote for this case."""
    case_ids = sorted({p.name[:-len("_0000.nii.gz")]
                       for p in Path(input_dir).glob("*_0000.nii.gz")})
    for case_id in case_ids:
        direct = Path(output_dir) / f"{case_id}.nii.gz"
        if direct.is_file():
            return direct
        matches = sorted(Path(output_dir).rglob(f"{case_id}.nii.gz"))
        if matches:
            return matches[0]
    raise PredictError(
        f"model '{spec.key}' produced no label map in {output_dir} "
        f"(expected one of {[c + '.nii.gz' for c in case_ids]})"
    )
