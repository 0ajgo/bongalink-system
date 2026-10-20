# Build from the repository root (docker-compose.yml does this):
#   docker build -f ml/worker/Dockerfile .
# The image mirrors the repo layout so the worker finds the Colab bootstrap model
# (ml/backend/models) and import_sales.py / the tests find the schema (Backend/database).
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    TF_CPP_MIN_LOG_LEVEL=2

WORKDIR /repo/ml/worker

# tensorflow-cpu: same API, no CUDA libraries (much smaller image).
# requirements.lock pins the audited versions (see the file), used as constraints.
COPY ml/worker/requirements.txt ml/worker/requirements.lock ./
RUN sed 's/^tensorflow\b/tensorflow-cpu/' requirements.txt > /tmp/requirements.txt \
 && pip install -r /tmp/requirements.txt -c requirements.lock

COPY ml/backend/models /repo/ml/backend/models
COPY Backend/database /repo/Backend/database
COPY ml/worker/bongalink_ml ./bongalink_ml
COPY ml/worker/import_sales.py ./
COPY ml/worker/tests ./tests

CMD ["python", "-m", "bongalink_ml"]
