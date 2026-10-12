"""Worker settings, read from environment variables (and ml/worker/.env if present).

Database variables use the same names as Backend/.env, so in Docker both
services can share one env file.
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

WORKER_DIR = Path(__file__).resolve().parent.parent

try:
    from dotenv import load_dotenv
    load_dotenv(WORKER_DIR / ".env")
except ImportError:  # python-dotenv is optional; plain env vars still work
    pass


def _int(name: str, default: int) -> int:
    return int(os.environ.get(name, default))


def _path(name: str, default: Path) -> Path:
    p = Path(os.environ.get(name, default))
    return p if p.is_absolute() else (WORKER_DIR / p).resolve()


@dataclass(frozen=True)
class Settings:
    db_host: str = os.environ.get("DB_HOST", "127.0.0.1")
    db_port: int = _int("DB_PORT", 3306)
    db_user: str = os.environ.get("DB_USER", "root")
    db_password: str = os.environ.get("DB_PASSWORD", "")
    db_name: str = os.environ.get("DB_NAME", "bongalink")

    poll_seconds: int = _int("ML_POLL_SECONDS", 5)
    quiet_seconds: int = _int("ML_QUIET_SECONDS", 10)          # debounce: wait for edits to stop...
    max_wait_seconds: int = _int("ML_MAX_WAIT_SECONDS", 60)    # ...but never longer than this
    full_refresh_minutes: int = _int("ML_FULL_REFRESH_MINUTES", 60)
    retry_seconds: int = _int("ML_RETRY_SECONDS", 30)          # back-off after a failed refresh

    cold_start_days: int = _int("ML_COLD_START_DAYS", 28)
    # Trend labels need sales on at least this many distinct days in the 84-day window.
    trend_min_sale_days: int = _int("ML_TREND_MIN_SALE_DAYS", 8)
    retrain_items: int = _int("ML_RETRAIN_ITEMS", 200)         # sold items since last training
    retrain_hour: int = _int("ML_RETRAIN_HOUR", 2)             # nightly retrain, local hour
    # "tensorflow" (default): retraining fails loudly if TensorFlow is missing.
    # "auto": fall back to closed-form least squares, recorded in trained_with.
    trainer: str = os.environ.get("ML_TRAINER", "tensorflow")

    models_dir: Path = _path("ML_MODELS_DIR", WORKER_DIR / "models")
    # Colab export used the first time the worker runs (and the fixed trend threshold).
    bootstrap_dir: Path = _path("ML_BOOTSTRAP_DIR", WORKER_DIR.parent / "backend" / "models")


def load() -> Settings:
    return Settings()
