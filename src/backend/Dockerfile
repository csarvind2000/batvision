# syntax=docker/dockerfile:1.7
###############################################################################
# batvision-backend — Django/DRF API and the Celery worker (same image, two CMDs)
###############################################################################
ARG PYTHON_IMAGE=python:3.12-slim-bookworm

# --------------------------------------------------------------------------- #
#  builder — resolve dependencies into a self-contained virtualenv
# --------------------------------------------------------------------------- #
FROM ${PYTHON_IMAGE} AS builder

ENV PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1 \
    VIRTUAL_ENV=/opt/venv \
    PATH=/opt/venv/bin:$PATH

# psycopg[binary] and the numpy/nibabel wheels need no toolchain, but keep the
# compiler available so a source-only dependency does not break the build.
RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential \
    && rm -rf /var/lib/apt/lists/*

RUN python -m venv "${VIRTUAL_ENV}"

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# --------------------------------------------------------------------------- #
#  runtime
# --------------------------------------------------------------------------- #
FROM ${PYTHON_IMAGE} AS runtime

LABEL org.opencontainers.image.title="batvision-backend"
LABEL org.opencontainers.image.description="BATVision Django API and Celery worker"

ARG APP_UID=1000
ARG APP_GID=1000

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    VIRTUAL_ENV=/opt/venv \
    PATH=/opt/venv/bin:$PATH \
    DJANGO_SETTINGS_MODULE=bfitserver.settings

RUN apt-get update && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /opt/venv /opt/venv

WORKDIR /app
COPY . .

# Same UID as the AI service so both can write the shared output volume.
RUN set -eux; \
    if ! getent group "${APP_GID}" >/dev/null; then groupadd --gid "${APP_GID}" batvision; fi; \
    if ! getent passwd "${APP_UID}" >/dev/null; then \
        useradd --uid "${APP_UID}" --gid "${APP_GID}" --no-create-home --shell /usr/sbin/nologin batvision; \
    fi; \
    mkdir -p /storage/bat_outputs /BAT_DataFolder; \
    chown -R "${APP_UID}:${APP_GID}" /app /storage /BAT_DataFolder

USER ${APP_UID}:${APP_GID}

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
    CMD curl -fsS http://127.0.0.1:8000/api/health/ || exit 1

# Overridden per service in docker-compose.yml (the worker runs celery instead).
CMD ["gunicorn", "bfitserver.wsgi:application", \
     "--bind", "0.0.0.0:8000", \
     "--workers", "3", "--timeout", "120", \
     "--access-logfile", "-", "--error-logfile", "-"]
