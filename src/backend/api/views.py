# /app/api/views.py
import os
import re
import json
import base64
from typing import Optional, List

from django.conf import settings
from django.http import JsonResponse
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_POST
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework import status as drf_status

import gzip
import shutil

import requests

from django.http import HttpResponse
from datetime import datetime

from . import cohort
from .models import Case, CaseInput
from .serializers import CaseSerializer
from .tasks import run_case_ai

# --- Optional deps for volume recompute ---
# If nibabel/numpy aren't installed, we will still SAVE the edited mask,
# but volume recompute will be skipped (and a warning added to bat_metrics.json)
try:
    import numpy as np  # type: ignore
except Exception:
    np = None

try:
    import nibabel as nib  # type: ignore
except Exception:
    nib = None


SUBJECT_RE = re.compile(r"^(?P<sid>.+)_(F_0000|FF_0001)\.nii(\.gz)?$", re.IGNORECASE)

FILENAME_SAFE_RE = re.compile(r"^[A-Za-z0-9._-]+$")


def _is_fat(name: str) -> bool:
    return "_f_0000.nii" in name.lower()


def _is_ff(name: str) -> bool:
    return "_ff_0001.nii" in name.lower()


def _file_to_b64(path: str) -> str:
    with open(path, "rb") as f:
        return base64.b64encode(f.read()).decode("utf-8")


def _first_existing(paths: List[Optional[str]]) -> Optional[str]:
    for p in paths:
        if p and os.path.exists(p):
            return p
    return None


def _read_json(path: str) -> Optional[dict]:
    try:
        with open(path, "r") as f:
            return json.load(f)
    except Exception:
        return None


def _safe_get(d: Optional[dict], path: List[str], default=None):
    cur = d or {}
    for k in path:
        if not isinstance(cur, dict) or k not in cur:
            return default
        cur = cur[k]
    return cur


def _sanitize_filename(name: str) -> str:
    name = (name or "").strip()
    if not name:
        raise ValueError("filename is required")
    if "/" in name or "\\" in name or ".." in name:
        raise ValueError("invalid filename")
    if not FILENAME_SAFE_RE.match(name):
        raise ValueError("filename has invalid characters")
    low = name.lower()
    if not (low.endswith(".nii") or low.endswith(".nii.gz")):
        raise ValueError("filename must end with .nii or .nii.gz")
    return name


def _b64_to_bytes(b64: str) -> bytes:
    if not b64:
        raise ValueError("edited_mask_b64 is required")
    # must be raw base64 (no data: prefix)
    return base64.b64decode(b64.encode("utf-8"))


def _get_possible_output_dirs(subject_id: str) -> List[str]:
    return [
        f"/BAT_DataFolder/output/{subject_id}",  # ✅ FIRST
        os.path.join(str(getattr(settings, "BAT_OUTPUT_DIR", "")), str(subject_id)),
        os.path.join(str(getattr(settings, "OUTPUT_ROOT", "")), str(subject_id)),
        os.path.join(str(getattr(settings, "OUTPUT_ROOT", "")), "bat_outputs", str(subject_id)),
        f"/BAT_DataFolder/output/bat_outputs/{subject_id}",
        f"/storage/bat_outputs/{subject_id}",
        f"/storage/bat_outputs/bat_outputs/{subject_id}",
    ]


def _resolve_output_dir(subject_id: str) -> Optional[str]:
    for base in _get_possible_output_dirs(subject_id):
        if base and os.path.isdir(base):
            return base
    return None


AI_BASE_URL = os.environ.get("AI_BASE_URL") or os.environ.get("AI_URL") or "http://ai:9000"
AI_TIMEOUT_S = int(os.environ.get("AI_TIMEOUT_S", str(60 * 60)))


def _join_ai_url(path: str) -> str:
    return AI_BASE_URL.rstrip("/") + "/" + path.lstrip("/")


def _compute_mask_volumes_ml(mask_path: str, mask_type: str) -> dict:
    """
    Computes ml volumes from mask nifti using voxel volume.
    - binary: label>0 total
    - c3: labels 1,2,3 breakdown + total
    - c4: labels 1,2,3,4 breakdown + total
    """
    if nib is None or np is None:
        raise RuntimeError("nibabel/numpy not installed; cannot recompute volumes")

    img = nib.load(mask_path)
    data = img.get_fdata().astype(np.int32)

    # voxel volume in mm^3 -> ml (1000 mm^3 = 1 ml)
    zooms = img.header.get_zooms()[:3]
    voxel_ml = (zooms[0] * zooms[1] * zooms[2]) / 1000.0

    def vol_ml_for(lbl: int) -> float:
        return float(np.sum(data == lbl) * voxel_ml)

    if mask_type == "binary":
        total = float(np.sum(data > 0) * voxel_ml)
        return {"binary_total_ml": total}

    if mask_type == "c3":
        b = {
            "class1_muscle_ml": vol_ml_for(1),
            "class2_brownfat_ml": vol_ml_for(2),
            "class3_mixwhite_ml": vol_ml_for(3),
        }
        total = float(sum(b.values()))
        return {"class3_total_ml": total, "class3_breakdown_ml": b}

    if mask_type == "c4":
        b = {
            "class1_muscle_ml": vol_ml_for(1),
            "class2_brownfat_ml": vol_ml_for(2),
            "class3_mixfat_ml": vol_ml_for(3),
            "class4_whitefat_ml": vol_ml_for(4),
        }
        total = float(sum(b.values()))
        return {"class4_total_ml": total, "class4_breakdown_ml": b}

    raise ValueError("invalid mask_type")


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def cases_list(request):
    qs = Case.objects.all().order_by("-created_at")
    return Response(CaseSerializer(qs, many=True).data)


@api_view(["POST"])
@permission_classes([IsAuthenticated])
def cases_upload(request):
    files = request.FILES.getlist("files")
    if not files:
        return Response({"detail": "No files uploaded. Use key 'files'."}, status=400)

    groups = {}
    skipped = []

    for f in files:
        m = SUBJECT_RE.match(f.name)
        if not m:
            skipped.append(f.name)
            continue
        sid = m.group("sid")
        groups.setdefault(sid, {})
        if _is_fat(f.name):
            groups[sid]["fat"] = f
        elif _is_ff(f.name):
            groups[sid]["fat_fraction"] = f

    created_ids = []
    base_dir = os.path.join(str(settings.UPLOAD_NIFTI_DIR), "bat_inputs")
    os.makedirs(base_dir, exist_ok=True)

    for sid, d in groups.items():
        if "fat" not in d or "fat_fraction" not in d:
            continue

        case, _ = Case.objects.get_or_create(case_id=sid)
        case.status = Case.STATUS_PROCESSING
        case.progress = 0
        case.status_message = "Uploaded"
        case.save(update_fields=["status", "progress", "status_message"])

        case_dir = os.path.join(base_dir, sid)
        os.makedirs(case_dir, exist_ok=True)

        fat_file = d["fat"]
        ff_file = d["fat_fraction"]
        fat_path = os.path.join(case_dir, fat_file.name)
        ff_path = os.path.join(case_dir, ff_file.name)

        with open(fat_path, "wb") as out:
            for chunk in fat_file.chunks():
                out.write(chunk)

        with open(ff_path, "wb") as out:
            for chunk in ff_file.chunks():
                out.write(chunk)

        CaseInput.objects.update_or_create(
            case=case,
            channel="fat",
            defaults={"filename": fat_file.name, "file_path": fat_path},
        )
        CaseInput.objects.update_or_create(
            case=case,
            channel="fat_fraction",
            defaults={"filename": ff_file.name, "file_path": ff_path},
        )

        # auto trigger AI processing after upload
        run_case_ai.delay(case.id)
        created_ids.append(case.id)

    if not created_ids:
        return Response(
            {
                "detail": "No valid cases created. Need both: <CASE>_F_0000.nii(.gz) and <CASE>_FF_0001.nii(.gz)",
                "skipped": skipped,
            },
            status=drf_status.HTTP_400_BAD_REQUEST,
        )

    return Response({"created_case_ids": created_ids, "skipped": skipped})


@api_view(["POST"])
@permission_classes([IsAuthenticated])
def cases_process(request):
    case_ids = request.data.get("case_ids", [])
    if not case_ids:
        return Response({"detail": "case_ids is required"}, status=400)

    queued = []
    for cid in case_ids:
        try:
            case = Case.objects.get(id=cid)
        except Case.DoesNotExist:
            continue

        case.status = Case.STATUS_PROCESSING
        case.progress = 1
        case.status_message = "Queued…"
        case.save(update_fields=["status", "progress", "status_message"])

        run_case_ai.delay(case.id)
        queued.append(case.id)

    return Response({"queued": queued})


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def cases_status(request, case_id: int):
    try:
        c = Case.objects.get(id=case_id)
        return Response(
            {
                "status": c.status,
                "progress": c.progress,
                "statusMessage": c.status_message,
            }
        )
    except Case.DoesNotExist:
        return Response({"detail": "Case not found"}, status=404)


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def cases_bat_review(request, case_id: int):
    """GET /api/cases/<id>/bat-review/"""
    return _bat_review_response(case_id)


def _bat_review_response(case_id: int):
    """The review payload, built independently of the request.

    Split out so save-annotation can return the freshly recomputed payload too.
    Calling the view directly did not work: it is an @api_view(["GET"]), so a
    POST reached it as a 405, and the DRF Request it was handed tripped an
    assertion before that.

    Returns:
      {
        case: {...},
        nifti: { image_b64, ff_b64, binary_b64, class4_b64, class3_b64, ... },
        volumes: {...},                     # now supports bat_metrics.json
        debug: { used_out_dir, found_files, metrics_json_path, ... }
      }
    """
    try:
        case = Case.objects.get(id=case_id)
    except Case.DoesNotExist:
        return Response({"detail": "Case not found"}, status=404)

    subject_id = getattr(case, "case_id", None) or str(case.id)

    possible_base_dirs = _get_possible_output_dirs(subject_id)

    found_out_dir = None
    binary_path = class4_path = class3_path = None
    found_files = []
    last_tried_dir = None

    for base in possible_base_dirs:
        last_tried_dir = base
        if not base or not os.path.isdir(base):
            continue

        # Edited masks come first: once a reviewer has corrected a mask, that is
        # the mask the app must show -- and it is what the review still shows if
        # re-stratification could not run. The model's own output is snapshotted
        # to <out_dir>/original/ the first time a case is edited.
        binary_cands = [
            "pred_binary_edited.nii.gz",
            "pred_binary.nii.gz",
            "bat_binary.nii.gz",
            "BAT_binary.nii.gz",
            "binary.nii.gz",
            "bat_mask.nii.gz",
            "segmentation_binary.nii.gz",
        ]
        class4_cands = [
            "mask_4class_edited.nii.gz",
            "mask_4class.nii.gz",
            "bat_4class.nii.gz",
            "BAT_4class.nii.gz",
            "pred_4class.nii.gz",
            "4class.nii.gz",
            "bat_class4.nii.gz",
            "multi_class_4.nii.gz",
        ]
        class3_cands = [
            "mask_3class_edited.nii.gz",
            "mask_3class.nii.gz",
            "bat_3class.nii.gz",
            "BAT_3class.nii.gz",
            "pred_3class.nii.gz",
            "3class.nii.gz",
            "bat_class3.nii.gz",
            "multi_class_3.nii.gz",
        ]

        binary_path = _first_existing([os.path.join(base, f) for f in binary_cands])
        class4_path = _first_existing([os.path.join(base, f) for f in class4_cands])
        class3_path = _first_existing([os.path.join(base, f) for f in class3_cands])

        if binary_path or class4_path or class3_path:
            found_out_dir = base
            try:
                found_files = sorted(os.listdir(base))
            except Exception:
                found_files = ["[permission denied]"]
            break

    # Input image: prefer CaseInput fat channel
    fat_input = CaseInput.objects.filter(case=case, channel="fat").first()
    fat_path = fat_input.file_path if fat_input else None

    # (Optional) fallback if DB missing fat: load <sid>_F_0000 from output dir
    if (not fat_path or not os.path.exists(fat_path)) and found_out_dir:
        fat_fallback = _first_existing(
            [
                os.path.join(found_out_dir, f"{subject_id}_F_0000.nii.gz"),
                os.path.join(found_out_dir, f"{subject_id}_F_0000.nii"),
            ]
        )
        if fat_fallback:
            fat_path = fat_fallback

    # Fat-fraction image: same lookup as fat, so the viewer's FAT / FAT FRACTION
    # toggle has a second volume to switch to. Optional on purpose -- a case
    # uploaded without it still reviews fine, the toggle just stays disabled.
    ff_input = CaseInput.objects.filter(case=case, channel="fat_fraction").first()
    ff_path = ff_input.file_path if ff_input else None

    if (not ff_path or not os.path.exists(ff_path)) and found_out_dir:
        ff_fallback = _first_existing(
            [
                os.path.join(found_out_dir, f"{subject_id}_FF_0001.nii.gz"),
                os.path.join(found_out_dir, f"{subject_id}_FF_0001.nii"),
            ]
        )
        if ff_fallback:
            ff_path = ff_fallback

    if ff_path and not os.path.exists(ff_path):
        ff_path = None

    missing = []
    if not fat_path or not os.path.exists(fat_path):
        missing.append("fat_input (CaseInput channel='fat' OR output fallback <sid>_F_0000)")
    if not binary_path:
        missing.append("binary mask file")
    if not class4_path:
        missing.append("4-class mask file")
    if not class3_path:
        missing.append("3-class mask file")

    if missing:
        return Response(
            {
                "detail": f"Missing files: {', '.join(missing)}",
                "out_dir": found_out_dir or "No valid output directory found",
                "subject_id": subject_id,
                "tried_directories": possible_base_dirs,
                "files_found_in_last_tried_dir": found_files if found_files else [],
                "last_tried_dir": last_tried_dir,
                "settings_BAT_OUTPUT_DIR": str(getattr(settings, "BAT_OUTPUT_DIR", "")),
                "settings_OUTPUT_ROOT": str(getattr(settings, "OUTPUT_ROOT", "")),
            },
            status=404,
        )

    # ✅ metrics JSON support (created by AI / updated by save-annotation)
    metrics_path = os.path.join(found_out_dir, "bat_metrics.json") if found_out_dir else None
    metrics = _read_json(metrics_path) if (metrics_path and os.path.exists(metrics_path)) else None

    # volumes: prefer DB if you already store it, else metrics json
    db_binary = getattr(case, "binary_total_ml", None) or getattr(case, "binary_volume", None)
    db_c4 = getattr(case, "class4_total_ml", None) or getattr(case, "class4_volume", None)
    db_c3 = getattr(case, "class3_total_ml", None) or getattr(case, "class3_volume", None)

    json_binary = _safe_get(metrics, ["volumes", "binary_total_ml"])
    json_c4 = _safe_get(metrics, ["volumes", "class4_total_ml"])
    json_c3 = _safe_get(metrics, ["volumes", "class3_total_ml"])

    volumes = {
        "binary_total_ml": db_binary if db_binary is not None else json_binary,
        "class4_total_ml": db_c4 if db_c4 is not None else json_c4,
        "class3_total_ml": db_c3 if db_c3 is not None else json_c3,
        "class4_breakdown_ml": _safe_get(metrics, ["volumes", "class4_breakdown_ml"]),
        "class3_breakdown_ml": _safe_get(metrics, ["volumes", "class3_breakdown_ml"]),
    }

    payload = {
        "case": {
            "patientName": subject_id,
            "patientId": subject_id,
            "status": getattr(case, "status", None),
            "seriesType": "BAT",
        },
        "nifti": {
            "image_b64": _file_to_b64(fat_path),
            "binary_b64": _file_to_b64(binary_path),
            "class4_b64": _file_to_b64(class4_path),
            "class3_b64": _file_to_b64(class3_path),
            "image_name": os.path.basename(fat_path),
            "binary_name": os.path.basename(binary_path),
            "class4_name": os.path.basename(class4_path),
            "class3_name": os.path.basename(class3_path),
            # absent when the case has no fat-fraction volume; the viewer keys
            # its FAT FRACTION toggle off exactly this
            "ff_b64": _file_to_b64(ff_path) if ff_path else None,
            "ff_name": os.path.basename(ff_path) if ff_path else None,
        },
        "volumes": volumes,
        "debug": {
            "used_output_directory": found_out_dir,
            "found_files_in_dir": found_files,
            "metrics_json_path": metrics_path,
            "fat_path": fat_path,
            "ff_path": ff_path,
            "metrics_json_loaded": bool(metrics),
            "metrics_keys": list(metrics.keys()) if isinstance(metrics, dict) else None,
        },
    }

    return Response(payload, status=200)


@api_view(["POST"])
@permission_classes([IsAuthenticated])
def cases_bat_review_save_annotation(request, case_id: int):
    """
    POST /api/cases/<id>/bat-review/save-annotation/
    Body:
      {
        "mask_type": "binary" | "c3" | "c4",
        "filename": "xxx.nii.gz",
        "edited_mask_b64": "<base64 bytes>"
      }

    Saves nifti into output folder, recomputes volumes (if nibabel installed),
    updates bat_metrics.json, and returns the same payload as GET /bat-review/.
    """
    try:
        case = Case.objects.get(id=case_id)
    except Case.DoesNotExist:
        return Response({"detail": "Case not found"}, status=404)

    subject_id = getattr(case, "case_id", None) or str(case.id)

    mask_type = (request.data.get("mask_type") or "").strip().lower()
    if mask_type not in ("binary", "c3", "c4"):
        return Response({"detail": "mask_type must be one of: binary, c3, c4"}, status=400)

    try:
        filename = _sanitize_filename(request.data.get("filename") or "")
        edited_bytes = _b64_to_bytes(request.data.get("edited_mask_b64") or "")
    except Exception as e:
        return Response({"detail": str(e)}, status=400)

    # Resolve / create output directory
    found_out_dir = _resolve_output_dir(subject_id)
    if not found_out_dir:
        found_out_dir = f"/BAT_DataFolder/output/{subject_id}"
        try:
            os.makedirs(found_out_dir, exist_ok=True)
        except Exception as e:
            return Response({"detail": f"Cannot create output dir: {found_out_dir} ({e})"}, status=500)

    # A .nii.gz path must actually be gzip. Niivue decides compression from the
    # filename it is given, and the viewer asks for the bytes back by passing an
    # empty one -- so a client can post uncompressed data under a .gz name,
    # which nibabel then refuses to read. Compress here when it is not already
    # compressed, rather than writing a file that lies about its format.
    if filename.lower().endswith(".gz") and edited_bytes[:2] != b"\x1f\x8b":
        try:
            edited_bytes = gzip.compress(edited_bytes)
        except Exception as e:
            return Response({"detail": f"Could not gzip the mask: {e}"}, status=400)

    save_path = os.path.join(found_out_dir, filename)
    try:
        with open(save_path, "wb") as f:
            f.write(edited_bytes)
    except Exception as e:
        return Response({"detail": f"Failed to write file: {e}"}, status=500)

    # Update / merge metrics json
    metrics_path = os.path.join(found_out_dir, "bat_metrics.json")
    metrics = _read_json(metrics_path) or {}
    metrics.setdefault("volumes", {})
    metrics.setdefault("annotations", [])

    # Keep a history record
    try:
        metrics["annotations"].append(
            {
                "filename": filename,
                "mask_type": mask_type,
            }
        )
    except Exception:
        pass

    # Editing the BAT mask invalidates far more than one number. The 3- and
    # 4-class maps are percentile bands of the fat-fraction distribution *inside*
    # the mask, so a corrected mask needs the whole stratification run again --
    # counting labels in the now-stale class maps would leave class3_total_ml
    # disagreeing with binary_total_ml. The AI service owns that code, so we ask
    # it rather than reimplementing it here and letting the two drift.
    restratified = False
    if mask_type == "binary":
        # Re-stratification rewrites pred_binary / mask_3class / mask_4class /
        # ff_percentile in place, so the model's own output would be gone after
        # the first edit. Snapshot it once, the first time a case is edited, and
        # never again -- so `original/` always holds what the model produced and
        # an edit stays auditable and reversible.
        original_dir = os.path.join(found_out_dir, "original")
        if not os.path.isdir(original_dir):
            try:
                os.makedirs(original_dir, exist_ok=True)
                for name in (
                    "pred_binary.nii.gz",
                    "pred_label.nii.gz",
                    "mask_3class.nii.gz",
                    "mask_4class.nii.gz",
                    "ff_percentile.nii.gz",
                    "bat_metrics.json",
                ):
                    src = os.path.join(found_out_dir, name)
                    if os.path.isfile(src):
                        shutil.copy2(src, os.path.join(original_dir, name))
            except Exception as e:
                metrics.setdefault("warnings", [])
                metrics["warnings"].append(f"original_snapshot_failed: {e}")

        fat_in = CaseInput.objects.filter(case=case, channel="fat").first()
        ff_in = CaseInput.objects.filter(case=case, channel="fat_fraction").first()
        fat_p = fat_in.file_path if fat_in else None
        ff_p = ff_in.file_path if ff_in else None

        if fat_p and ff_p and os.path.exists(fat_p) and os.path.exists(ff_p):
            try:
                r = requests.post(
                    _join_ai_url("/restratify"),
                    json={
                        "case_id": subject_id,
                        "fat_path": fat_p,
                        "ff_path": ff_p,
                        "mask_path": save_path,
                        "out_dir": found_out_dir,
                    },
                    timeout=AI_TIMEOUT_S,
                )
                if r.ok:
                    restratified = True
                    # Re-stratification regenerates mask_3class / mask_4class
                    # from the corrected BAT mask, which supersedes any earlier
                    # hand-edited class map: those were derived from a mask that
                    # no longer exists. Left in place they keep winning the
                    # *_edited preference in the candidate lists above, so the
                    # class overlays and their volumes silently disagree with
                    # the binary mask. Archive rather than delete -- it is still
                    # someone's manual work.
                    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
                    superseded_dir = os.path.join(found_out_dir, "superseded")
                    for stale in ("mask_3class_edited.nii.gz", "mask_4class_edited.nii.gz"):
                        stale_path = os.path.join(found_out_dir, stale)
                        if not os.path.isfile(stale_path):
                            continue
                        try:
                            os.makedirs(superseded_dir, exist_ok=True)
                            shutil.move(
                                stale_path, os.path.join(superseded_dir, f"{stamp}_{stale}")
                            )
                        except Exception as e:
                            metrics.setdefault("warnings", [])
                            metrics["warnings"].append(f"could_not_archive_{stale}: {e}")
                    # postprocess rewrote bat_metrics.json itself; re-read rather
                    # than merging, so we cannot half-overwrite its output.
                    metrics = _read_json(metrics_path) or metrics
                    metrics.setdefault("annotations", [])
                    metrics["annotations"].append(
                        {"filename": filename, "mask_type": mask_type, "restratified": True}
                    )
                else:
                    metrics.setdefault("warnings", [])
                    metrics["warnings"].append(f"restratify_failed: {r.status_code} {r.text[:300]}")
            except Exception as e:
                metrics.setdefault("warnings", [])
                metrics["warnings"].append(f"restratify_unavailable: {e}")
        else:
            metrics.setdefault("warnings", [])
            metrics["warnings"].append(
                "restratify_skipped: fat/fat_fraction inputs not on disk for this case"
            )

    if not restratified:
        # A class map was edited directly, or re-stratification was unavailable:
        # fall back to counting labels in the file just saved.
        try:
            new_vols = _compute_mask_volumes_ml(save_path, mask_type)
            metrics["volumes"].update(new_vols)
        except Exception as e:
            metrics.setdefault("warnings", [])
            metrics["warnings"].append(f"volume_recompute_failed: {str(e)}")

    try:
        with open(metrics_path, "w") as f:
            json.dump(metrics, f, indent=2)
    except Exception:
        # do not fail the request if json write fails
        pass

    # The same payload GET /bat-review/ returns, so the frontend refreshes in one
    # round trip.
    return _bat_review_response(case_id)


@csrf_exempt
@require_POST
def cases_delete(request):
    """
    POST /api/cases/delete/
    Body: {"ids":[1,2,3]}
    """
    try:
        payload = json.loads(request.body.decode("utf-8") or "{}")
        ids = payload.get("ids", [])
        if not isinstance(ids, list) or len(ids) == 0:
            return JsonResponse({"error": "ids must be a non-empty list"}, status=400)

        qs = Case.objects.filter(id__in=ids)
        found = list(qs.values_list("id", flat=True))
        deleted_count, _ = qs.delete()

        return JsonResponse(
            {"ok": True, "requested": ids, "found": found, "deleted": deleted_count},
            status=200,
        )
    except Exception as e:
        return JsonResponse({"error": str(e)}, status=500)

# ---------------------------------------------------------------------------
# cohort
# ---------------------------------------------------------------------------
def _cohort_rows(ids: Optional[List[int]] = None) -> List[dict]:
    """Every case (or just `ids`) flattened to one row of volumes."""
    queryset = Case.objects.all().order_by("case_id")
    if ids:
        queryset = queryset.filter(pk__in=ids)

    rows = []
    for case in queryset:
        subject_id = getattr(case, "case_id", None) or str(case.pk)
        out_dir = _resolve_output_dir(subject_id)
        rows.append(cohort.case_to_row(case, out_dir, cohort.read_metrics(out_dir)))
    return rows


def _requested_ids(request) -> Optional[List[int]]:
    """`?ids=1,2,3` restricts the export to a hand-picked selection."""
    raw = (request.GET.get("ids") or "").strip()
    if not raw:
        return None
    out = []
    for part in raw.split(","):
        part = part.strip()
        if part.isdigit():
            out.append(int(part))
    return out or None


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def cohort_list(request):
    """GET /api/cohort/ — the cohort table plus its aggregates."""
    rows = _cohort_rows()
    return Response(
        {
            "columns": [
                {"key": key, "label": label, "group": group}
                for group, columns in (
                    ("identity", cohort.BASE_COLUMNS),
                    ("volumes", cohort.VOLUME_COLUMNS),
                    ("qc", cohort.QC_COLUMNS),
                )
                for key, label in columns
            ],
            "rows": rows,
            "summary": cohort.summarise(rows),
        },
        status=200,
    )


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def cohort_export(request):
    """GET /api/cohort/export/?fmt=xlsx|csv[&ids=1,2,3] — the sheet as a file.

    The parameter is `fmt`, not `format`: DRF reserves `format` for renderer
    selection (URL_FORMAT_OVERRIDE), so `?format=xlsx` makes content negotiation
    look for an "xlsx" renderer and raise Http404 before the view ever runs.
    """
    fmt = (request.GET.get("fmt") or "xlsx").lower()
    rows = _cohort_rows(_requested_ids(request))
    stamp = datetime.now().strftime("%Y%m%d-%H%M")

    if fmt == "csv":
        response = HttpResponse(cohort.rows_to_csv(rows), content_type="text/csv")
        response["Content-Disposition"] = f'attachment; filename="bat-cohort-{stamp}.csv"'
        return response

    if fmt != "xlsx":
        return Response({"error": f"Unsupported fmt {fmt!r}; use xlsx or csv"}, status=400)

    try:
        content = cohort.build_workbook(rows, cohort.summarise(rows))
    except ImportError:
        return Response(
            {"error": "openpyxl is not installed in the backend image; use format=csv"},
            status=501,
        )

    response = HttpResponse(
        content,
        content_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    )
    response["Content-Disposition"] = f'attachment; filename="bat-cohort-{stamp}.xlsx"'
    return response



# ---------------------------------------------------------------------------
# health
# ---------------------------------------------------------------------------
@csrf_exempt
def health(request):
    """Unauthenticated liveness probe, used by the container HEALTHCHECK."""
    return JsonResponse({"ok": True, "service": "batvision-backend"})
