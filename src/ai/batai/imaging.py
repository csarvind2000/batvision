"""SimpleITK helpers shared by the inference pipeline."""
from __future__ import annotations

from pathlib import Path

import SimpleITK as sitk


def read_img(p: Path | str) -> sitk.Image:
    return sitk.ReadImage(str(p))


def write_img(img: sitk.Image, p: Path | str) -> None:
    p = Path(p)
    p.parent.mkdir(parents=True, exist_ok=True)
    sitk.WriteImage(img, str(p))


def same_geometry(a: sitk.Image, b: sitk.Image) -> bool:
    return (
        a.GetSize() == b.GetSize()
        and a.GetSpacing() == b.GetSpacing()
        and a.GetOrigin() == b.GetOrigin()
        and a.GetDirection() == b.GetDirection()
    )


def voxel_volume_ml(ref: sitk.Image) -> float:
    """Voxel volume in millilitres (spacing is in mm, 1 mL = 1000 mm^3)."""
    sx, sy, sz = ref.GetSpacing()
    return float(sx * sy * sz) / 1000.0


def align_to_ref(ref: sitk.Image, moving: sitk.Image, is_label: bool) -> sitk.Image:
    """Resample `moving` onto `ref`'s grid, nearest-neighbour for label maps."""
    if same_geometry(ref, moving):
        return moving
    interp = sitk.sitkNearestNeighbor if is_label else sitk.sitkLinear
    return sitk.Resample(moving, ref, sitk.Transform(), interp, 0.0, moving.GetPixelID())
