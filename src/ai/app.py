"""HTTP entry point for the BATVision inference service.

    GET  /health          liveness
    GET  /readyz          readiness: are the selected model's weights mounted?
    GET  /models          the model registry, with availability
    POST /infer           segment one case

The response shape of /infer is stable across models; `model` names which one
produced it.
"""
from __future__ import annotations

import logging
import traceback
from pathlib import Path

from flask import Flask, jsonify, request

from batai import __version__, config
from batai.pipeline import run_case
from batai.postprocess import postprocess
from batai.predict import PredictError

logging.basicConfig(
    level=logging.DEBUG if config.DEBUG else logging.INFO,
    format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
)
log = logging.getLogger("batai")

app = Flask(__name__)


@app.get("/health")
def health():
    return jsonify({"ok": True, "service": "batvision-ai", "version": __version__})


@app.get("/readyz")
def readyz():
    spec = config.get_model(None)
    missing = spec.missing_files()
    return jsonify({
        "ok": not missing,
        "model": spec.key,
        "missing": missing,
    }), (200 if not missing else 503)


@app.get("/models")
def models():
    return jsonify({
        "ok": True,
        "default": config.DEFAULT_MODEL,
        "device": config.DEVICE,
        "models": [s.as_dict() for s in config.MODELS.values()],
    })


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
            "received": {"fat_path": bool(fat_path), "ff_path": bool(ff_path),
                         "case_id": case_id},
        }), 400

    try:
        spec = config.get_model(payload.get("model"))
    except KeyError as e:
        # str() on a KeyError re-quotes its argument; args[0] is the plain message
        return jsonify({"error": e.args[0]}), 400

    fat_p, ff_p = Path(fat_path), Path(ff_path)
    for label, p in (("fat_path", fat_p), ("ff_path", ff_p)):
        if not p.exists():
            return jsonify({"error": f"{label} not found: {p}"}), 400

    out_base = Path(out_dir) if out_dir else (config.OUT_BASE / case_id)

    log.info("infer case=%s model=%s -> %s", case_id, spec.key, out_base)
    try:
        result = run_case(spec, case_id, fat_p, ff_p, out_base)
    except PredictError as e:
        log.error("inference failed for %s: %s", case_id, e)
        return jsonify({"error": str(e), "case_id": case_id, "model": spec.key}), 500
    except Exception as e:                                    # noqa: BLE001
        log.error("inference failed for %s: %s\n%s", case_id, e, traceback.format_exc())
        return jsonify({"error": str(e), "case_id": case_id, "model": spec.key}), 500

    log.info("infer case=%s done in %ss", case_id, result.get("duration_s"))
    return jsonify({
        "ok": True,
        "case_id": case_id,
        "out_dir": str(out_base),
        "message": f"Ready to review ({spec.name})",
        **result,
    })


@app.post("/restratify")
def restratify():
    """Re-derive the class maps and volumes from an edited BAT mask.

    A reviewer's manual correction changes which voxels are BAT, and the 3- and
    4-class maps are percentile bands of the fat-fraction distribution *inside*
    that mask -- so both class maps and every volume are invalid the moment the
    mask is edited. Counting labels in the old class maps cannot fix that; the
    stratification has to be run again.

    This re-runs exactly the postprocessing the model run used, minus inference,
    so an edited case and a fresh case are computed by the same code path.
    """
    if not request.is_json:
        return jsonify({"error": "Expected JSON body"}), 400

    payload = request.json or {}
    case_id = (payload.get("case_id") or "").strip()
    fat_path = payload.get("fat_path")
    ff_path = payload.get("ff_path")
    mask_path = payload.get("mask_path")
    out_dir = payload.get("out_dir")

    missing = [
        name
        for name, value in (
            ("case_id", case_id),
            ("fat_path", fat_path),
            ("ff_path", ff_path),
            ("mask_path", mask_path),
        )
        if not value
    ]
    if missing:
        return jsonify({"error": f"missing required field(s): {', '.join(missing)}"}), 400

    fat_p, ff_p, mask_p = Path(fat_path), Path(ff_path), Path(mask_path)
    for label, path in (("fat_path", fat_p), ("ff_path", ff_p), ("mask_path", mask_p)):
        if not path.exists():
            return jsonify({"error": f"{label} not found: {path}"}), 400

    try:
        spec = config.get_model(payload.get("model"))
    except KeyError as e:
        return jsonify({"error": e.args[0]}), 400

    out_base = Path(out_dir) if out_dir else (config.OUT_BASE / case_id)

    log.info("restratify case=%s from %s", case_id, mask_p)
    try:
        result = postprocess(spec, case_id, fat_p, ff_p, mask_p, out_base)
    except Exception as e:                                    # noqa: BLE001
        log.error("restratify failed for %s: %s\n%s", case_id, e, traceback.format_exc())
        return jsonify({"error": str(e), "case_id": case_id}), 500

    return jsonify({
        "ok": True,
        "case_id": case_id,
        "out_dir": str(out_base),
        "message": "Recomputed from the edited mask",
        "model": spec.as_dict(),
        **result,
    })


if __name__ == "__main__":
    # Development server only; the image runs gunicorn (see the Dockerfile CMD).
    app.run(host=config.HOST, port=config.PORT, debug=config.DEBUG, threaded=False)
