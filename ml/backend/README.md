# ml/backend/models

The Colab export (`ml/colab/bongalink_training.ipynb`, section 5) that the Python ML worker starts from:

- `stock_lr.json`: linear regression weights and feature scaling. On its first run the worker
  registers it as model `v0-colab` (`ML_BOOTSTRAP_DIR`).
- `trend_config.json`: the trend window and the shift threshold calibrated in Colab.
- `parity.json`: one fixed example with the exact numbers the notebook computed.
  `ml/worker/tests/test_core.py` checks the worker reproduces them.

The worker's Docker image copies this folder (`ml/worker/Dockerfile`).
