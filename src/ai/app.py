# app.py
import os
import json
import tempfile
import subprocess
from pathlib import Path

import numpy as np
import SimpleITK as sitk
from flask import Flask, request, jsonify

# ----------------------------
# Configure nnUNet env
# ----------------------------
NNUNET_BASE = Path(os.environ.get("NNUNET_BASE", "/app"))

os.environ["nnUNet_raw"] = str(NNUNET_BASE / "nnunet_raw")
os.environ["nnUNet_preprocessed"] = str(NNUNET_BASE / "nnunet_preprocessed")
os.environ["nnUNet_results"] = str(NNUNET_BASE / "nnunet_results")

DATASET_ID = int(os.environ.get("NNUNET_DATASET_ID", "901"))
CONFIG = os.environ.get("NNUNET_CONFIG", "3d_fullres")
TRAINER = os.environ.get("NNUNET_TRAINER", "nnUNetTrainerTopK10Loss_33os_1000epochs")
PLANS = os.environ.get("NNUNET_PLANS", "nnUNetPlans")
FOLDS = os.environ.get("NNUNET_FOLDS", "0")

# IMPORTANT: you said your real outputs are here:
BAT_OUT_BASE = Path(os.environ.get("BAT_OUT_BASE", "/BAT_DataFolder/output"))

DEBUG = os.environ.get("DEBUG_MODE", "true").lower() == "true"

app = Flask(__name__)


# ----------------------------
# Helpers
# ----------------------------
def read_img(p: Path) -> sitk.Image:
    return sitk.ReadImage(str(p))


def write_img(img: sitk.Image, p: Path) -> None:
    p.parent.mkdir(parents=True, exist_ok=True)
    sitk.WriteImage(img, str(p))


def voxel_volume_ml(ref_img: sitk.Image) -> float:
    sp = ref_img.GetSpacing()
    # spacing in mm -> mm^3. 1 mL = 1000 mm^3
    return float(sp[0] * sp[1] * sp[2]) / 1000.0


def align_to_ref(ref: sitk.Image, moving: sitk.Image, is_label: bool) -> sitk.Image:
    same = (
        ref.GetSize() == moving.GetSize()
        and ref.GetSpacing() == moving.GetSpacing()
        and ref.GetOrigin() == moving.GetOrigin()
        and ref.GetDirection() == moving.GetDirection()
    )
    if same:
        return moving
    interp = sitk.sitkNearestNeighbor if is_label else sitk.sitkLinear
    return sitk.Resample(moving, ref, sitk.Transform(), interp, 0.0, moving.GetPixelID())


def compute_percentile_map(values: np.ndarray) -> np.ndarray:
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


def classify_percentiles_to_4class(pct_full: np.ndarray) -> np.ndarray:
    out = np.zeros(pct_full.shape, dtype=np.uint8)
    out[(pct_full >= 0) & (pct_full <= 20)] = 1
    out[(pct_full > 20) & (pct_full <= 60)] = 2
    out[(pct_full > 60) & (pct_full <= 80)] = 3
    out[(pct_full > 80)] = 4
    return out


def make_3class_from_4class(cls4: np.ndarray) -> np.ndarray:
    """
    3-class mapping:
      0 background
      1 muscle (4class==1)
      2 brown fat (4class==2)
      3 mix+white (4class in {3,4})
    """
    out = np.zeros_like(cls4, dtype=np.uint8)
    out[cls4 == 1] = 1
    out[cls4 == 2] = 2
    out[(cls4 == 3) | (cls4 == 4)] = 3
    return out


def build_flat_input_one(case_id: str, fat: Path, ff: Path, flat_dir: Path) -> tuple[Path, Path]:
    flat_dir.mkdir(parents=True, exist_ok=True)
    fat_out = flat_dir / f"{case_id}_0000.nii.gz"
    ff_out = flat_dir / f"{case_id}_0001.nii.gz"

    for p in [fat_out, ff_out]:
        if p.exists() or p.is_symlink():
            p.unlink()

    # fat as symlink
    fat_out.symlink_to(fat)

    # ff resample onto fat if needed
    fat_img = read_img(fat)
    ff_img = read_img(ff)

    same = (
        fat_img.GetSize() == ff_img.GetSize()
        and fat_img.GetSpacing() == ff_img.GetSpacing()
        and fat_img.GetOrigin() == ff_img.GetOrigin()
        and fat_img.GetDirection() == ff_img.GetDirection()
    )

    if same:
        ff_out.symlink_to(ff)
    else:
        ff_res = sitk.Resample(ff_img, fat_img, sitk.Transform(), sitk.sitkLinear, 0.0, ff_img.GetPixelID())
        write_img(ff_res, ff_out)

    return fat_out, ff_out


def run_nnunet_predict(input_dir: Path, pred_dir: Path) -> None:
    pred_dir.mkdir(parents=True, exist_ok=True)
    folds = [x.strip() for x in FOLDS.split(",") if x.strip()]

    cmd = [
        "nnUNetv2_predict",
        "-d", str(DATASET_ID),
        "-c", CONFIG,
        "-i", str(input_dir),
        "-o", str(pred_dir),
        "-f", *folds,
    ]
    if TRAINER:
        cmd += ["-tr", TRAINER]
    if PLANS:
        cmd += ["-p", PLANS]

    subprocess.run(cmd, check=True)


def write_metrics_json(out_dir: Path, metrics: dict) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    p = out_dir / "bat_metrics.json"
    with open(p, "w") as f:
        json.dump(metrics, f, indent=2)
    return p


def postprocess(case_id: str, fat_p: Path, ff_p: Path, pred_label_p: Path, out_dir: Path) -> dict:
    fat_img = read_img(fat_p)
    ff_img = align_to_ref(fat_img, read_img(ff_p), is_label=False)
    pred_img = align_to_ref(fat_img, read_img(pred_label_p), is_label=True)

    ff_arr = sitk.GetArrayFromImage(ff_img).astype(np.float32)
    # nnUNet output label -> BAT mask (binary)
    pred_arr = (sitk.GetArrayFromImage(pred_img) > 0).astype(np.uint8)

    vv_ml = voxel_volume_ml(fat_img)

    # ---- Binary BAT volume (2-class overlay)
    pred_vox = int(pred_arr.sum())
    vol_pred_ml = float(pred_vox * vv_ml)

    # ---- Percentiles inside BAT only
    pct_full = np.zeros_like(ff_arr, dtype=np.float32)
    idx = np.where(pred_arr == 1)
    pct_vals = compute_percentile_map(ff_arr[idx])
    pct_full[idx] = pct_vals

    # ---- 4-class (only inside BAT)
    cls4_full = np.zeros_like(pred_arr, dtype=np.uint8)
    cls4_masked = classify_percentiles_to_4class(pct_full)
    cls4_full[pred_arr == 1] = cls4_masked[pred_arr == 1]

    # ---- 3-class from 4-class
    cls3_full = make_3class_from_4class(cls4_full)

    # ---- volumes: 4-class breakdown
    vol_c1 = float((cls4_full == 1).sum() * vv_ml)
    vol_c2 = float((cls4_full == 2).sum() * vv_ml)
    vol_c3 = float((cls4_full == 3).sum() * vv_ml)
    vol_c4 = float((cls4_full == 4).sum() * vv_ml)

    # ---- volumes: 3-class breakdown
    vol_3c1 = float((cls3_full == 1).sum() * vv_ml)
    vol_3c2 = float((cls3_full == 2).sum() * vv_ml)
    vol_3c3 = float((cls3_full == 3).sum() * vv_ml)

    # totals (these SHOULD equal binary_total_ml since they partition BAT mask)
    class4_total_ml = float(vol_c1 + vol_c2 + vol_c3 + vol_c4)
    class3_total_ml = float(vol_3c1 + vol_3c2 + vol_3c3)

    out_dir.mkdir(parents=True, exist_ok=True)

    # ---- write outputs
    p_bin = out_dir / "pred_binary.nii.gz"
    p_3 = out_dir / "mask_3class.nii.gz"
    p_4 = out_dir / "mask_4class.nii.gz"
    p_pct = out_dir / "ff_percentile.nii.gz"

    pred_bin = sitk.GetImageFromArray(pred_arr.astype(np.uint8))
    pred_bin.CopyInformation(fat_img)
    write_img(pred_bin, p_bin)

    m3 = sitk.GetImageFromArray(cls3_full.astype(np.uint8))
    m3.CopyInformation(fat_img)
    write_img(m3, p_3)

    m4 = sitk.GetImageFromArray(cls4_full.astype(np.uint8))
    m4.CopyInformation(fat_img)
    write_img(m4, p_4)

    pct_img = sitk.GetImageFromArray(pct_full.astype(np.float32))
    pct_img.CopyInformation(fat_img)
    write_img(pct_img, p_pct)

    files = {
        "pred_label": str(pred_label_p),
        "pred_binary": str(p_bin),
        "mask_3class": str(p_3),
        "mask_4class": str(p_4),
        "ff_percentile": str(p_pct),
    }

    stats = {
        "case_id": case_id,
        "voxel_volume_ml": vv_ml,
        "pred_voxels": pred_vox,
    }

    volumes = {
        "binary_total_ml": vol_pred_ml,

        "class3_total_ml": class3_total_ml,
        "class3_breakdown_ml": {
            "class1_muscle_ml": vol_3c1,
            "class2_brownfat_ml": vol_3c2,
            "class3_mixwhite_ml": vol_3c3,
        },

        "class4_total_ml": class4_total_ml,
        "class4_breakdown_ml": {
            "class1_muscle_ml": vol_c1,
            "class2_brownfat_ml": vol_c2,
            "class3_mixfat_ml": vol_c3,
            "class4_whitefat_ml": vol_c4,
        },
    }

    metrics = {
        "ok": True,
        "case_id": case_id,
        "out_dir": str(out_dir),
        "files": files,
        "stats": stats,
        "volumes": volumes,
    }

    metrics_path = write_metrics_json(out_dir, metrics)
    files["metrics_json"] = str(metrics_path)

    return {"files": files, "stats": stats, "volumes": volumes}


# ----------------------------
# Routes
# ----------------------------
@app.get("/health")
def health():
    return jsonify({"ok": True})


@app.post("/infer")
def infer():
    if not request.is_json:
        return jsonify({"error": "Expected JSON body"}), 400

    payload = request.json or {}

    fat_path = payload.get("fat_path")
    ff_path = payload.get("ff_path")
    case_id = (payload.get("case_id") or "").strip()
    out_dir = payload.get("out_dir")

    if not fat_path or not ff_path or not case_id:
        return jsonify({
            "error": "fat_path, ff_path, case_id are required",
            "received": {"fat_path": bool(fat_path), "ff_path": bool(ff_path), "case_id": case_id}
        }), 400

    fat_p = Path(fat_path)
    ff_p = Path(ff_path)

    if not fat_p.exists():
        return jsonify({"error": f"fat_path not found: {fat_p}"}), 400
    if not ff_p.exists():
        return jsonify({"error": f"ff_path not found: {ff_p}"}), 400

    out_base = Path(out_dir) if out_dir else (BAT_OUT_BASE / case_id)
    out_base.mkdir(parents=True, exist_ok=True)

    tmp_root = Path("/app/tmp")
    tmp_root.mkdir(parents=True, exist_ok=True)
    work_dir = Path(tempfile.mkdtemp(dir=str(tmp_root)))

    try:
        flat_in = work_dir / "flat_in"
        pred_out = work_dir / "pred_out"

        build_flat_input_one(case_id, fat_p, ff_p, flat_in)
        run_nnunet_predict(flat_in, pred_out)

        pred_label = pred_out / f"{case_id}.nii.gz"
        if not pred_label.exists():
            matches = list(pred_out.rglob(f"{case_id}.nii.gz"))
            if matches:
                pred_label = matches[0]
            else:
                return jsonify({"error": f"Pred label missing for {case_id}"}), 500

        result = postprocess(case_id, fat_p, ff_p, pred_label, out_base)

        return jsonify({
            "ok": True,
            "case_id": case_id,
            "out_dir": str(out_base),
            "message": "Ready to review",
            **result
        })

    except subprocess.CalledProcessError as e:
        return jsonify({"error": f"nnUNet predict failed: {str(e)}"}), 500
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    finally:
        if not DEBUG:
            import shutil
            shutil.rmtree(work_dir, ignore_errors=True)


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=9000, debug=DEBUG, threaded=False)