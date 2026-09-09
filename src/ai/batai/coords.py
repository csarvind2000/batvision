"""Anatomical Coordinate Channels (ACC) for AGB-Net.

AGB-Net is trained on Dataset602_BAT_AGB, which is Dataset601 plus three extra
input channels: affine ramps over the body bounding box, carried through
nnU-Net's preprocessing as ``nonorm`` channels.  The network's ACC-FiLM module
reads them to know *where in the body* a patch sits, and its Bilateral Symmetry
Fusion module recovers the mid-sagittal plane from the left-right ramp.

Inference therefore has to build the very same channels before calling
``nnUNetv2_predict``.  The three functions below are a verbatim copy of
``batnet/make_coord_dataset.py`` -- the definition used to build the training
data.  IF EITHER SIDE CHANGES, CHANGE BOTH: a coordinate frame that differs
between training and inference silently degrades every prediction.

Channel layout expected by the model:

    0  fat
    1  fat_fraction
    2  coord along raw axis 0   (left-right)
    3  coord along raw axis 1
    4  coord along raw axis 2   (superior-inferior)
"""
from __future__ import annotations

from pathlib import Path

import nibabel as nib
import numpy as np
from scipy import ndimage as ndi

COORD_LO, COORD_HI = 0.05, 1.0

#: below this many voxels the body mask is considered to have failed and the
#: whole volume is used as the coordinate frame instead
MIN_FRAME_VOXELS = 1000


def _largest_cc(m: np.ndarray) -> np.ndarray:
    lab, n = ndi.label(m)
    if n > 1:
        sizes = ndi.sum(m, lab, range(1, n + 1))
        m = lab == (int(np.argmax(sizes)) + 1)
    return m


def frame_mask(fat: np.ndarray, ff: np.ndarray) -> np.ndarray:
    """Body mask defining the *coordinate frame*.

    Must be intensity-thresholded, not merely nonzero: out-of-body noise voxels
    are nonzero and drag the bounding box off-centre.  With the threshold the
    BAT centroid lands at 0.492/0.470/0.550 with SD 0.019/0.037/0.063 (n=150);
    with a plain nonzero mask the left-right centroid drifts to 0.62-0.68, which
    destroys the very symmetry the frame is supposed to encode.
    """
    m = (fat > 0.02 * np.percentile(fat, 99.5)) | (ff > 0.02 * np.percentile(ff, 99.5))
    m = ndi.binary_closing(m, np.ones((3, 3, 3)))
    m = ndi.binary_fill_holes(m)
    return _largest_cc(m)


def support_mask(fat: np.ndarray, ff: np.ndarray) -> np.ndarray:
    """Exactly the mask nnU-Net's crop_to_nonzero computes, so that writing the
    coordinate channels leaves the cropping behaviour bit-for-bit unchanged."""
    return ndi.binary_fill_holes((fat != 0) | (ff != 0))


def coord_channels(frame: np.ndarray, support: np.ndarray) -> np.ndarray:
    """(3, X, Y, Z) affine ramps over the bounding box of `frame`, zeroed outside `support`."""
    idx = np.array(np.nonzero(frame))
    lo, hi = idx.min(1), idx.max(1)
    ext = np.maximum(hi - lo, 1)
    out = np.zeros((3,) + frame.shape, dtype=np.float32)
    for a in range(3):
        r = (np.arange(frame.shape[a], dtype=np.float32) - lo[a]) / ext[a]
        r = np.clip(r, 0.0, 1.0) * (COORD_HI - COORD_LO) + COORD_LO
        shape = [1, 1, 1]
        shape[a] = -1
        out[a] = r.reshape(shape)
    out *= support.astype(np.float32)       # 0 outside -> cropping unchanged
    return out


def write_coord_channels(case_id: str, fat_p: Path, ff_p: Path, out_dir: Path) -> list[Path]:
    """Write ``<case_id>_0002/_0003/_0004.nii.gz`` next to the image channels.

    `fat_p` and `ff_p` must already be on a common grid -- the pipeline resamples
    the fat-fraction volume onto the fat volume before calling this.
    """
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    f0 = nib.load(str(fat_p))
    a0 = np.asanyarray(f0.dataobj).astype(np.float32)
    a1 = np.asanyarray(nib.load(str(ff_p)).dataobj).astype(np.float32)

    if a0.shape != a1.shape:
        raise ValueError(
            f"{case_id}: fat {a0.shape} and fat-fraction {a1.shape} must share a grid "
            "before the coordinate channels can be built"
        )

    fm = frame_mask(a0, a1)
    if fm.sum() < MIN_FRAME_VOXELS:
        fm = np.ones(a0.shape, dtype=bool)
    c = coord_channels(fm, support_mask(a0, a1))

    written = []
    for i in range(3):
        p = out_dir / f"{case_id}_000{i + 2}.nii.gz"
        img = nib.Nifti1Image(c[i], f0.affine, f0.header)
        img.set_data_dtype(np.float32)
        nib.save(img, str(p))
        written.append(p)
    return written
