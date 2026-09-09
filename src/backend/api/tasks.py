# /app/api/tasks.py
import os
import requests
from celery import shared_task
from .models import Case, CaseInput, AnalysisJob

def _join_url(base: str, path: str) -> str:
    base = (base or "").rstrip("/")
    path = (path or "").strip()
    if not path.startswith("/"):
        path = "/" + path
    return base + path

def _safe_json(resp: requests.Response):
    try:
        return resp.json()
    except Exception:
        return None

# AI_BASE_URL is what docker-compose sets; AI_URL is kept as a legacy alias so
# an existing .env keeps working.
AI_URL = os.environ.get("AI_BASE_URL") or os.environ.get("AI_URL") or "http://ai:9000"
AI_INFER_PATH = os.environ.get("AI_INFER_PATH", "/infer")

# Which registered model the AI service should run ("agbnet", "baseline", ...).
# Empty means "whatever the AI service is configured to default to".
AI_MODEL = os.environ.get("AI_MODEL", "").strip()

# A 3D nnU-Net prediction takes minutes; the ceiling is a stuck container, not a
# slow case.
AI_TIMEOUT_S = int(os.environ.get("AI_TIMEOUT_S", str(60 * 60)))

@shared_task(bind=True)
def run_case_ai(self, case_pk: int):
    case = Case.objects.get(pk=case_pk)

    job = AnalysisJob.objects.create(
        case=case, status="running", progress=5, message="Started"
    )

    try:
        # ---- inputs from DB
        fat_in = CaseInput.objects.get(case=case, channel="fat").file_path
        ff_in  = CaseInput.objects.get(case=case, channel="fat_fraction").file_path

        # ---- make sure case_id exists (this is the #1 silent 400 cause)
        case_id = (getattr(case, "case_id", None) or getattr(case, "subject_id", None) or "").strip()
        if not case_id:
            raise RuntimeError("case_id is empty in DB (cannot call AI).")

        out_dir = f"/storage/bat_outputs/{case_id}"
        os.makedirs(out_dir, exist_ok=True)

        # ---- update Case + Job
        case.status = Case.STATUS_PROCESSING
        case.progress = 10
        case.status_message = "Calling AI…"
        case.save(update_fields=["status", "progress", "status_message"])

        job.progress = 10
        job.message = "Calling AI…"
        job.save(update_fields=["progress", "message"])

        url = _join_url(AI_URL, AI_INFER_PATH)

        payload = {
            "fat_path": fat_in,
            "ff_path": ff_in,
            "out_dir": out_dir,
            "case_id": case_id,
        }
        if AI_MODEL:
            payload["model"] = AI_MODEL

        # ---- call AI
        r = requests.post(url, json=payload, timeout=AI_TIMEOUT_S)

        # ✅ show real error body (instead of generic HTTPError)
        if not r.ok:
            raise RuntimeError(f"AI {r.status_code} @ {url}: {r.text}")

        resp = _safe_json(r) or {}

        msg = resp.get("message") or resp.get("status_message") or "Completed"
        out_dir_resp = resp.get("out_dir") or out_dir
        model_name = (resp.get("model") or {}).get("name")
        if model_name and model_name not in msg:
            msg = f"{msg} — {model_name}"

        # ---- mark completed
        job.status = "completed"
        job.progress = 100
        job.output_dir = out_dir_resp
        job.message = msg
        job.save(update_fields=["status", "progress", "output_dir", "message"])

        case.status = Case.STATUS_READY
        case.progress = 100
        case.status_message = msg
        case.save(update_fields=["status", "progress", "status_message"])

        # Optional: store returned file paths if your model has these fields
        # case.pred_binary_path = resp.get("files", {}).get("pred_binary")
        # case.mask_3class_path = resp.get("files", {}).get("mask_3class")
        # case.mask_4class_path = resp.get("files", {}).get("mask_4class")
        # case.save(update_fields=[...])

        return {"ok": True, "case_id": case_id, "out_dir": out_dir_resp, "ai": resp}

    except Exception as e:
        job.status = "failed"
        job.progress = 0
        job.message = str(e)
        job.save(update_fields=["status", "progress", "message"])

        case.status = Case.STATUS_FAILED
        case.progress = 0
        case.status_message = str(e)
        case.save(update_fields=["status", "progress", "status_message"])

        raise
