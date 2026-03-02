# ai/Dockerfile
FROM pytorch/pytorch:2.4.0-cuda12.1-cudnn9-runtime

RUN apt-get update && apt-get install -y \
    git curl ffmpeg libglib2.0-0 libsm6 libxext6 libxrender1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

COPY . /app

# ✅ Copy your custom nnUNet trainer into the installed nnunetv2 package
# Expect file at: /app/trainers/nnUNetTrainerTopK10Loss_33os_1000epochs.py
RUN set -eux; \
    python -c "import sysconfig; print(sysconfig.get_paths()['purelib'])" > /tmp/purelib.txt; \
    PURELIB="$(cat /tmp/purelib.txt)"; \
    echo "PURELIB=$PURELIB"; \
    TARGET_DIR="$PURELIB/nnunetv2/training/nnUNetTrainer"; \
    echo "TARGET_DIR=$TARGET_DIR"; \
    mkdir -p "$TARGET_DIR"; \
    cp -v "/app/trainers/nnUNetTrainerTopK10Loss_33os_1000epochs.py" "$TARGET_DIR/"; \
    python -c "from nnunetv2.training.nnUNetTrainer.nnUNetTrainerTopK10Loss_33os_1000epochs import nnUNetTrainerTopK10Loss_33os_1000epochs; print('Custom trainer import OK')"

EXPOSE 9000
CMD ["python", "app.py"]
