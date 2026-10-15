"""python -m bongalink_ml            run the worker until stopped (Ctrl+C / docker stop)
   python -m bongalink_ml --once     process pending events (or refresh everything) once, then exit
   python -m bongalink_ml --retrain  retrain now (ignores the automatic schedule), then exit
"""
import argparse
import logging
import os
import signal
import sys

from . import config
from .worker import Worker


def main() -> int:
    parser = argparse.ArgumentParser(prog="bongalink_ml", description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--once", action="store_true", help="one forced update, then exit")
    parser.add_argument("--retrain", action="store_true", help="retrain now, then exit")
    args = parser.parse_args()

    logging.basicConfig(level=os.environ.get("ML_LOG_LEVEL", "INFO"),
                        format="%(asctime)s %(levelname)-7s %(name)s: %(message)s")
    # Docker sends SIGTERM on stop; exit cleanly instead of printing a traceback.
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))

    worker = Worker(config.load())
    if args.retrain:
        result = worker.maybe_retrain(force=True)
        if result is None:
            print("Another training run is already queued or in progress; try again when it finishes.")
            return 1
        print(result.message)
        return 0 if result.status in ("promoted", "rejected", "skipped") else 1
    if args.once:
        if not worker.process_events(force=True):
            worker.refresh(None, "manual --once")
        return 0
    try:
        worker.run_forever()
    except KeyboardInterrupt:
        logging.getLogger("bongalink_ml").info("worker stopped")
    return 0


if __name__ == "__main__":
    sys.exit(main())
