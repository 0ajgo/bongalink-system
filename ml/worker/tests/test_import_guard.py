"""import_sales.py drops and rebuilds its target database, so it must never target the shop's
databases. No database or sales sheet needed: the refusal comes before either is touched.
Run from ml/worker:  python -m unittest discover -s tests -t . -v"""
import subprocess
import sys
import unittest
from pathlib import Path

WORKER = Path(__file__).resolve().parents[1]


def run(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run([sys.executable, "import_sales.py", *args], cwd=WORKER,
                          capture_output=True, text=True, timeout=60)


class ImportGuard(unittest.TestCase):
    def test_refuses_the_shops_databases_even_for_a_dry_run(self):
        for name in ("bongalink_real", "bongalink"):
            with self.subTest(name=name):
                result = run("--database", name, "--dry-run", "--file", "no-such-sheet.xlsx")
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(f"refusing to import into '{name}' (the shop's database)", result.stderr)

    def test_default_target_is_a_new_copy(self):
        sys.path.insert(0, str(WORKER))
        try:
            import import_sales
        finally:
            sys.path.remove(str(WORKER))
        self.assertEqual(import_sales.DEFAULT_DATABASE, "bongalink_import")
        self.assertNotIn(import_sales.DEFAULT_DATABASE, import_sales.PROTECTED_DBS)
        self.assertEqual(set(import_sales.PROTECTED_DBS), {"bongalink_real", "bongalink"})


if __name__ == "__main__":
    unittest.main()
