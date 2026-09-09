# syntax=docker/dockerfile:1.7
###############################################################################
# batvision-ai — brown adipose tissue segmentation service
#
#   models served (registry lives in batai/config.py):
#     agbnet    Dataset602_BAT_AGB  nnUNetTrainerAGBNet__nnUNetResEncUNetMPlans_AGB
#     baseline  Dataset901_...      nnUNetTrainerTopK10Loss_33os_1000epochs__nnUNetPlans
#
# Weights are NOT baked in — the results tree is bind-mounted read-only at
# /models/nnunet_results. See docker-compose.yml.
###############################################################################

# Matches the environment AGB-Net was trained in (torch 2.7.1+cu126, cuDNN 9).
# CUDA 12.6 runs on a >= 525 host driver through CUDA minor-version compatibility.
ARG PYTORCH_IMAGE=pytorch/pytorch:2.7.1-cuda12.6-cudnn9-runtime

# --------------------------------------------------------------------------- #
#  single stage: the CUDA torch in the base image is the thing we build on, so
#  a builder/runtime split would mean hard-coding where that image keeps its
#  Python. Toolchain is installed and purged inside one layer instead.
# --------------------------------------------------------------------------- #
FROM ${PYTORCH_IMAGE} AS runtime

LABEL org.opencontainers.image.title="batvision-ai"
LABEL org.opencontainers.image.description="AGB-Net / nnU-Net brown adipose tissue segmentation service"

ARG APP_UID=1000
ARG APP_GID=1000

# nnU-Net reads these three from the environment; only results is used at
# inference, but it refuses to import unless all three are set.
ENV nnUNet_results=/models/nnunet_results
ENV nnUNet_raw=/models/nnunet_raw
ENV nnUNet_preprocessed=/models/nnunet_preprocessed
ENV BATAI_MODELS_ROOT=/models \
    BATAI_OUT_BASE=/storage/bat_outputs \
    BATAI_TMP_DIR=/tmp/batai \
    HOME=/tmp \
    MPLCONFIGDIR=/tmp/matplotlib \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

RUN apt-get update && apt-get install -y --no-install-recommends \
        curl libglib2.0-0 libsm6 libxext6 libxrender1 \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt /tmp/requirements.txt

# Constrain torch to the version the base image already ships: nnunetv2 only
# requires torch>=2.1.2, and without the pin a resolver hiccup can swap the CUDA
# build for a CPU wheel -- which fails at inference, not at build time.
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends build-essential; \
    python -c "import importlib.metadata as m; print('torch==' + m.version('torch'))" \
        > /tmp/constraints.txt; \
    cat /tmp/constraints.txt; \
    pip install --no-cache-dir -c /tmp/constraints.txt -r /tmp/requirements.txt; \
    python -c "import torch; assert torch.version.cuda, 'the CUDA torch was replaced by a CPU wheel'; print('torch', torch.__version__, 'cuda', torch.version.cuda)"; \
    apt-get purge -y --auto-remove build-essential; \
    rm -rf /var/lib/apt/lists/* /tmp/requirements.txt /tmp/constraints.txt

WORKDIR /app
COPY app.py ./
COPY batai/ ./batai/
COPY nnunet_ext/ ./nnunet_ext/

# nnU-Net resolves a trainer by class name inside its own package — at inference
# just as much as at training — so the custom trainers have to live there.
# Importing them here turns a broken trainer into a build failure rather than a
# 500 on the first case.
RUN set -eux; \
    TARGET="$(python -c 'import nnunetv2, os; print(os.path.join(os.path.dirname(nnunetv2.__file__), "training", "nnUNetTrainer"))')"; \
    echo "installing custom trainers into ${TARGET}"; \
    cp -v /app/nnunet_ext/*.py "${TARGET}/"; \
    python -c "\
from nnunetv2.training.nnUNetTrainer.nnUNetTrainerAGBNet import nnUNetTrainerAGBNet;\
from nnunetv2.training.nnUNetTrainer.nnUNetTrainerTopK10Loss_33os_1000epochs import nnUNetTrainerTopK10Loss_33os_1000epochs;\
print('custom trainers import OK')"

# Run unprivileged. The UID must match the owner of the mounted output volume,
# otherwise the service cannot write its results (override with --build-arg).
RUN set -eux; \
    if ! getent group "${APP_GID}" >/dev/null; then groupadd --gid "${APP_GID}" batai; fi; \
    if ! getent passwd "${APP_UID}" >/dev/null; then \
        useradd --uid "${APP_UID}" --gid "${APP_GID}" --no-create-home --shell /usr/sbin/nologin batai; \
    fi; \
    mkdir -p /models /storage/bat_outputs /tmp/batai /tmp/matplotlib; \
    chown -R "${APP_UID}:${APP_GID}" /app /storage /tmp/batai /tmp/matplotlib

USER ${APP_UID}:${APP_GID}

EXPOSE 9000

HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
    CMD curl -fsS http://127.0.0.1:9000/health || exit 1

# One worker, one thread, no timeout: a 3D nnU-Net prediction owns the GPU for
# minutes at a time, so requests are deliberately serialised.
CMD ["gunicorn", "--bind", "0.0.0.0:9000", \
     "--workers", "1", "--threads", "1", "--timeout", "0", \
     "--access-logfile", "-", "--error-logfile", "-", \
     "app:app"]
