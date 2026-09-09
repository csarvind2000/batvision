"""Fat-fraction percentile stratification of a BAT mask, and the volumes it yields.

The segmentation gives *where* BAT is; the clinical read-out is *how brown* it
is.  Within the predicted mask the fat-fraction values are ranked into
percentiles and cut into four classes (and a coarser three-class merge), from
which per-class volumes in millilitres are reported.
"""
from __future__ import annotations

import json
import shutil
from pathlib import Path

import numpy as np
import SimpleITK as sitk

from .config import ModelSpec
from .imaging import align_to_ref, read_img, voxel_volume_ml, write_img

#: percentile cut points of the fat-fraction distribution inside the BAT mask
CLASS4_EDGES = (20.0, 60.0, 80.0)

CLASS4_LABELS = {
    1: "muscle",
    2: "brown_fat",
    3: "mixed_fat",
    4: "white_fat",
}

CLASS3_LABELS = {
    1: "muscle",
    2: "brown_fat",
    3: "mixed_and_white_fat",
}


def compute_percentile_map(values: np.ndarray) -> np.ndarray:
    """Average-rank percentiles of `values`, in [0, 100]; ties share a rank."""
    n = values.size
    if n == 0:
        return values.astype(np.float32)

    order = np.argsort(values, kind="mergesort")
    ranks = np.empty(n, dtype=np.float64)
    ranks[order] = np.arange(1, n + 1, dtype=np.float64)

    sorted_vals = values[order]
    start = 0
    while start < n:
        end = start + 1
        while end < n and sorted_vals[end] == sorted_vals[start]:
            end += 1
        if end - start > 1:
            avg_rank = ranks[order[start:end]].mean()
            ranks[order[start:end]] = avg_rank
        start = end

    pct = (ranks - 1) / max(n - 1, 1) * 100.0
    return pct.astype(np.float32)


def classify_percentiles_to_4class(pct: np.ndarray) -> np.ndarray:
    lo, mid, hi = CLASS4_EDGES
    out = np.zeros(pct.shape, dtype=np.uint8)
    out[(pct >= 0) & (pct <= lo)] = 1
    out[(pct > lo) & (pct <= mid)] = 2
    out[(pct > mid) & (pct <= hi)] = 3
    out[pct > hi] = 4
    return out


def make_3class_from_4class(cls4: np.ndarray) -> np.ndarray:
    """0 background, 1 muscle, 2 brown fat, 3 mixed + white fat."""
    out = np.zeros_like(cls4, dtype=np.uint8)
    out[cls4 == 1] = 1
    out[cls4 == 2] = 2
    out[(cls4 == 3) | (cls4 == 4)] = 3
    return out


def _save_like(ref: sitk.Image, arr: np.ndarray, path: Path) -> Path:
    img = sitk.GetImageFromArray(arr)
    img.CopyInformation(ref)
    write_img(img, path)
    return path


def postprocess(spec: ModelSpec, case_id: str, fat_p: Path, ff_p: Path,
                pred_label_p: Path, out_dir: Path) -> dict:
    """Write the derived masks and return files / stats / volumes for the API."""
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    fat_img = read_img(fat_p)
    ff_img = align_to_ref(fat_img, read_img(ff_p), is_label=False)
    pred_img = align_to_ref(fat_img, read_img(pred_label_p), is_label=True)

    ff_arr = sitk.GetArrayFromImage(ff_img).astype(np.float32)
    pred_arr = (sitk.GetArrayFromImage(pred_img) > 0).astype(np.uint8)

    vv_ml = voxel_volume_ml(fat_img)
    pred_vox = int(pred_arr.sum())

    # percentiles are computed inside the BAT mask only
    pct_full = np.zeros_like(ff_arr, dtype=np.float32)
    inside = pred_arr == 1
    pct_full[inside] = compute_percentile_map(ff_arr[inside])

    cls4 = np.zeros_like(pred_arr, dtype=np.uint8)
    cls4[inside] = classify_percentiles_to_4class(pct_full)[inside]
    cls3 = make_3class_from_4class(cls4)

    vol4 = {c: float((cls4 == c).sum() * vv_ml) for c in CLASS4_LABELS}
    vol3 = {c: float((cls3 == c).sum() * vv_ml) for c in CLASS3_LABELS}

    # nnU-Net writes its raw label map into a per-case working directory that is
    # deleted once the run finishes, so keep a copy next to the derived masks --
    # otherwise bat_metrics.json records a path that no longer exists.
    kept_label = out_dir / "pred_label.nii.gz"
    if Path(pred_label_p).resolve() != kept_label.resolve():
        shutil.copy2(pred_label_p, kept_label)

    files = {
        "pred_label": str(kept_label),
        "pred_binary": str(_save_like(fat_img, pred_arr, out_dir / "pred_binary.nii.gz")),
        "mask_3class": str(_save_like(fat_img, cls3, out_dir / "mask_3class.nii.gz")),
        "mask_4class": str(_save_like(fat_img, cls4, out_dir / "mask_4class.nii.gz")),
        "ff_percentile": str(_save_like(fat_img, pct_full, out_dir / "ff_percentile.nii.gz")),
    }

    stats = {
        "case_id": case_id,
        "voxel_volume_ml": vv_ml,
        "pred_voxels": pred_vox,
    }

    volumes = {
        "binary_total_ml": float(pred_vox * vv_ml),

        # the two breakdowns partition the same mask, so both totals must equal
        # binary_total_ml -- keeping them in the payload makes that checkable
        "class3_total_ml": float(sum(vol3.values())),
        "class3_breakdown_ml": {
            "class1_muscle_ml": vol3[1],
            "class2_brownfat_ml": vol3[2],
            "class3_mixwhite_ml": vol3[3],
        },

        "class4_total_ml": float(sum(vol4.values())),
        "class4_breakdown_ml": {
            "class1_muscle_ml": vol4[1],
            "class2_brownfat_ml": vol4[2],
            "class3_mixfat_ml": vol4[3],
            "class4_whitefat_ml": vol4[4],
        },
    }

    metrics = {
        "ok": True,
        "case_id": case_id,
        "model": spec.as_dict(),
        "out_dir": str(out_dir),
        "class_labels": {"class3": CLASS3_LABELS, "class4": CLASS4_LABELS},
        "files": files,
        "stats": stats,
        "volumes": volumes,
    }

    metrics_path = out_dir / "bat_metrics.json"
    with open(metrics_path, "w") as f:
        json.dump(metrics, f, indent=2)
    files["metrics_json"] = str(metrics_path)

    return {"files": files, "stats": stats, "volumes": volumes}
