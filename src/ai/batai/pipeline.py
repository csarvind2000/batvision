"""End-to-end: (fat, fat-fraction) -> segmentation -> stratified volumes."""
from __future__ import annotations

import shutil
import tempfile
import time
from pathlib import Path

from . import config
from .config import ModelSpec
from .postprocess import postprocess
from .predict import build_input_folder, run_predict


def run_case(spec: ModelSpec, case_id: str, fat_p: Path, ff_p: Path,
             out_dir: Path) -> dict:
    """Segment one case and write every derived file into `out_dir`."""
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    config.TMP_DIR.mkdir(parents=True, exist_ok=True)
    work_dir = Path(tempfile.mkdtemp(prefix=f"{case_id}-", dir=str(config.TMP_DIR)))

    started = time.monotonic()
    try:
        flat_in = build_input_folder(spec, case_id, fat_p, ff_p, work_dir / "input")
        pred_label = run_predict(spec, flat_in, work_dir / "prediction")
        result = postprocess(spec, case_id, fat_p, ff_p, pred_label, out_dir)
    finally:
        if not config.KEEP_WORKDIR:
            shutil.rmtree(work_dir, ignore_errors=True)

    result["model"] = spec.as_dict()
    result["duration_s"] = round(time.monotonic() - started, 1)
    return result
