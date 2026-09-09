# BATVision — Docker stack

Web platform for **brown adipose tissue (BAT)** segmentation, review and
volumetric analysis. Everything runs in Docker: the React review UI, the Django
API, a Celery worker, Postgres/Redis, and a GPU inference service that serves
**AGB-Net**.

---

## Services

| service | image | container | ports (host → container) | what it does |
|---|---|---|---|---|
| `frontend` | `batvision/frontend` | `batvision-frontend` | 5173 → 5173 | React + Vite BAT review UI, Niivue viewer |
| `backend` | `batvision/backend` | `batvision-backend` | 8000 → 8000 | Django/DRF: auth, cases, review API |
| `worker` | `batvision/backend` | `batvision-worker` | — | Celery worker; calls the AI service per case |
| `ai` | `batvision/ai` | `batvision-ai` | 9000 → 9000 | **AGB-Net / nnU-Net segmentation, needs the GPU** |
| `db` | `postgres:16-alpine` | `batvision-db` | 5433 → 5432 | application database |
| `redis` | `redis:7-alpine` | `batvision-redis` | 6379 → 6379 | Celery broker and result backend |

Named volumes: `batvision-pgdata`, `batvision-redis`, `batvision-ai-tmp`.

The frontend listens on **5173 inside the container in both modes** — Vite in
dev, nginx in prod. That is deliberate: if the two modes used different
container ports, the dev override would have to re-map an already-published
port, and Compose merges `ports` by appending, so the container ends up asking
for the same host port twice and the daemon refuses it with
`Bind for 0.0.0.0:5173 failed: port is already allocated`.

---

## The models

The AI service carries a registry of models (`src/ai/batai/config.py`); the
active one is picked with `BATAI_MODEL` and can be overridden per request.

### `agbnet` — AGB-Net (default)

Anatomy-Guided Bilateral Network. An nnU-Net **ResEnc-M** backbone plus three
modules, each aimed at a measured failure mode of the baseline:

* **ACC-FiLM** — three anatomical coordinate ramps are fed as extra input
  channels and turned into per-stage (γ, β) modulation, so a patch knows where
  in the body it sits. BAT's intensity signature is biologically unstable, its
  location is not.
* **BSF** — Bilateral Symmetry Fusion mirrors mid-resolution features about the
  subject's own mid-sagittal plane, so evidence on the visible depot is carried
  to the faint contralateral one.
* **TSR** — a full-resolution Thin-Structure Refinement head that emits a
  residual correction to the logits, where 72–92 % of all FP/FN voxels live.

```
Dataset602_BAT_AGB / nnUNetTrainerAGBNet__nnUNetResEncUNetMPlans_AGB__3d_fullres
5 input channels: fat, fat-fraction, 3 coordinate ramps · fold 0 · checkpoint_best.pth
```

Fold 0, 58 cases, identical split: mean Dice **0.8614** vs 0.8575 for the
baseline (median 0.8808 vs 0.8789; Wilcoxon p = 1.1e-3).

The coordinate channels are built at inference by `src/ai/batai/coords.py`,
which is a copy of `BAT/batnet/make_coord_dataset.py` — the same definition the
training data was built with. **If the coordinate frame changes in one place it
must change in the other**, or predictions degrade silently.

### `baseline` — nnU-Net TopK10

The previous production model, kept for comparison and fallback.

```
Dataset901_BAT_Longitudinal_UNION_45y_6y / nnUNetTrainerTopK10Loss_33os_1000epochs__nnUNetPlans__3d_fullres
2 input channels: fat, fat-fraction · fold 0 · checkpoint_final.pth
```

### Weights

Weights are **never** baked into the image or committed — they are far past
GitHub's file size limits. Download them from Google Drive:

```
https://drive.google.com/drive/folders/1po6c_ogZZJr-FkMZljP1w_1HhSXylw4J?usp=sharing
```

Put the downloaded tree anywhere on the host and point `BAT_MODELS_HOST_DIR` at
the directory that *contains* the dataset folders. It is bind-mounted read-only
at `/models/nnunet_results`, so it no longer has to live under `src/ai/`:

```
<BAT_MODELS_HOST_DIR>/
├── Dataset602_BAT_AGB/                                   # AGB-Net (default)
│   └── nnUNetTrainerAGBNet__nnUNetResEncUNetMPlans_AGB__3d_fullres/
│       ├── fold_0/checkpoint_best.pth
│       ├── plans.json
│       └── dataset.json
└── Dataset901_BAT_Longitudinal_UNION_45y_6y/             # baseline
    └── nnUNetTrainerTopK10Loss_33os_1000epochs__nnUNetPlans__3d_fullres/
        ├── fold_0/checkpoint_final.pth
        ├── plans.json
        └── dataset.json
```

Check what the service can see:

```bash
curl -s localhost:9000/models | python3 -m json.tool
curl -s localhost:9000/readyz          # 503 + the missing paths if weights are absent
```

Custom nnU-Net trainers live in `src/ai/nnunet_ext/` and are copied into
`site-packages/nnunetv2/training/nnUNetTrainer/` during the image build — nnU-Net
resolves trainers by class name inside its own package, at inference as well as
at training. The build imports them, so a broken trainer fails the build rather
than the first case.

---

## Demo

[![BATVision Demo](https://img.youtube.com/vi/993zxbC57AM/0.jpg)](https://www.youtube.com/watch?v=993zxbC57AM)

Click the thumbnail to watch on YouTube.

---

## Prerequisites

* Docker Engine + Compose **v2.24 or newer** (`docker-compose.cpu.yml` uses `!override`)
* NVIDIA driver ≥ 525 and the **NVIDIA Container Toolkit** for the `ai` service
* ~12 GB of free VRAM for AGB-Net at the planned patch size

No GPU? See [Running without a GPU](#running-without-a-gpu).

---

## Quick start

```bash
cd src
cp .env.example .env
$EDITOR .env          # BAT_DATA_HOST_DIR, BAT_MODELS_HOST_DIR, APP_UID/APP_GID, secrets

docker compose up -d --build
docker compose ps
```

* Frontend — http://localhost:5173
* Backend — http://localhost:8000/api/health/
* AI — http://localhost:9000/models

`docker compose up` picks up `docker-compose.override.yml` automatically, which
gives you the **development** stack: source bind-mounted, Django `runserver`,
Vite with HMR, Flask's debug server for the AI.

For the **production** shape — gunicorn, nginx, no bind mounts — skip the
override file:

```bash
docker compose -f docker-compose.yml up -d --build
```

First-time Django setup:

```bash
docker compose exec backend python manage.py createsuperuser
```

---

## Configuration

Everything lives in `src/.env`; `src/.env.example` is the annotated template.
The variables you must set:

| variable | meaning |
|---|---|
| `BAT_DATA_HOST_DIR` | host directory holding case data; results are written to `<dir>/output` |
| `BAT_MODELS_HOST_DIR` | host nnU-Net **results** tree, mounted read-only at `/models/nnunet_results` |
| `APP_UID` / `APP_GID` | the UID/GID owning those directories — containers run unprivileged (`id -u`, `id -g`) |
| `DJANGO_SECRET_KEY`, `POSTGRES_PASSWORD` | secrets, no defaults |

Model selection:

| variable | meaning |
|---|---|
| `BATAI_MODEL` | `agbnet` (default) or `baseline` |
| `AI_MODEL` | forces a model from the backend, overriding the AI default; empty = follow `BATAI_MODEL` |
| `BATAI_DEVICE` | `cuda` (default) or `cpu` |
| `BATAI_DISABLE_TTA` | `1` trades a little accuracy for roughly 8× less inference time |
| `BATAI_AGBNET_FOLDS`, `BATAI_AGBNET_CHECKPOINT`, … | per-model overrides of any registry field |

---

## The AI API

```
GET  /health    liveness
GET  /readyz    are the selected model's weights actually mounted?
GET  /models    the registry, with availability per model
POST /infer     segment one case
```

```bash
curl -s localhost:9000/infer -H 'Content-Type: application/json' -d '{
  "case_id": "010-04002",
  "fat_path": "/BAT_DataFolder/media/nifti/010-04002_F_0000.nii.gz",
  "ff_path":  "/BAT_DataFolder/media/nifti/010-04002_FF_0001.nii.gz",
  "model":    "agbnet"
}' | python3 -m json.tool
```

`model` is optional and defaults to `BATAI_MODEL`. The response carries
`files`, `stats`, `volumes`, the resolved `model`, and `duration_s`; the same
payload is written to `<out_dir>/bat_metrics.json`.

Outputs per case, in `<BAT_DATA_HOST_DIR>/output/<case_id>/`:

| file | contents |
|---|---|
| `pred_binary.nii.gz` | the BAT mask |
| `mask_3class.nii.gz` | muscle / brown fat / mixed+white fat |
| `mask_4class.nii.gz` | muscle / brown / mixed / white fat |
| `ff_percentile.nii.gz` | fat-fraction percentile within the mask |
| `bat_metrics.json` | per-class volumes in mL, plus which model produced them |

The class maps are percentile cuts of the fat-fraction distribution *inside* the
predicted mask, so both breakdowns partition the same mask and both totals equal
`binary_total_ml`.

---

## Running without a GPU

```bash
docker compose -f docker-compose.yml -f docker-compose.cpu.yml up -d --build
```

This sets `BATAI_DEVICE=cpu`, disables test-time augmentation and drops the GPU
reservation. A 3D full-resolution prediction on CPU takes tens of minutes per
case — it is for smoke-testing the wiring, not for real use.

---

## Everyday commands

```bash
docker compose logs -f ai            # inference progress and tracebacks
docker compose logs -f worker        # celery task lifecycle
docker compose ps                    # health status per container
docker compose restart ai            # pick up Python edits in dev
docker compose build ai --no-cache   # after changing requirements or trainers
docker compose down                  # stop
docker compose down -v               # stop AND DELETE the database volume
```

Rebuild for a specific image tag:

```bash
BATVISION_TAG=2026.09 docker compose -f docker-compose.yml build
```

---

## Repository layout

```
batApp-docker/
├── analysis/                        volumetrics spreadsheets and plots
└── src/
    ├── .env.example                 annotated configuration template
    ├── docker-compose.yml           base stack (production shape)
    ├── docker-compose.override.yml  development: bind mounts, hot reload
    ├── docker-compose.cpu.yml       opt-out of the GPU reservation
    ├── ai/                          inference service  → batvision/ai
    │   ├── app.py                   Flask routes (health / readyz / models / infer)
    │   ├── batai/
    │   │   ├── config.py            model registry + env parsing
    │   │   ├── coords.py            AGB-Net anatomical coordinate channels
    │   │   ├── imaging.py           SimpleITK helpers
    │   │   ├── predict.py           input layout + nnUNetv2_predict
    │   │   ├── postprocess.py       percentile stratification and volumes
    │   │   └── pipeline.py          one case, end to end
    │   └── nnunet_ext/              custom trainers installed into nnunetv2
    ├── backend/                     Django/DRF + Celery  → batvision/backend
    └── WebGUI/frontend/             React + Vite         → batvision/frontend
```

---

## Migrating from the previous layout

The compose project is now named `batvision` and volumes carry explicit names,
so a stack started before this change uses different volume names. To keep the
existing database:

```bash
docker compose down
docker run --rm -v src_pgdata:/from -v batvision-pgdata:/to alpine \
  sh -c "cd /from && cp -a . /to"
docker compose up -d
```

Other renames:

* `env_example` → `.env.example`, and several variables were renamed:
  `BAT_OUT_BASE` → `BATAI_OUT_BASE`, `DEBUG_MODE` → `BATAI_DEBUG`,
  `NNUNET_*` model settings → the per-model `BATAI_<MODEL>_*` overrides.
  The old names are still read where it costs nothing, but `.env.example` is
  the reference.
* `docker-compose.dev.yaml` is gone. It referenced `./WebGUI/backend` and
  `./nnUnet`, neither of which exists in this repository.
* Containers `bat-*` are now `batvision-*`.

---

## Troubleshooting

**`ai` exits or `/readyz` returns 503.** The weights are not where the service
looks. `curl -s localhost:9000/readyz` lists the exact missing paths; check
`BAT_MODELS_HOST_DIR` points at the tree containing `Dataset602_BAT_AGB/`.

**`CUDA error: no kernel image` / torch sees no GPU.** The NVIDIA Container
Toolkit is not installed or not configured for the Docker daemon. Verify with
`docker run --rm --gpus all nvidia/cuda:12.6.0-base-ubuntu22.04 nvidia-smi`.

**CUDA out of memory.** AGB-Net needs ~7 GB at the planned patch size. Close
other GPU users, or set `BATAI_DISABLE_TTA=1`.

**Permission denied writing to `/storage/bat_outputs`.** `APP_UID`/`APP_GID` do
not match the owner of `BAT_DATA_HOST_DIR`. Fix them in `.env` and rebuild —
they are build arguments, not runtime settings.

**`nnUNetv2_predict` cannot find the trainer.** The image build copies
`src/ai/nnunet_ext/*.py` into nnU-Net's package. If a trainer was added there
after the last build, rebuild: `docker compose build ai`.

**Niivue shows the base volume but not the mask.** Load the base with
`loadVolumes` and the mask with `loadDrawing(...)` + `setDrawOpacity` — loading a
mask as a volume makes it replace the base rather than overlay it. Also confirm
the two share dimensions and that the mask is not all zeros, and that
`base64NiftiToObjectUrl` uses `application/gzip` for `.nii.gz`.

**JWT `token_not_valid`.** The access token expired; use the refresh flow at
`POST /api/auth/refresh/`, or log in again.
