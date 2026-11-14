#!/usr/bin/env python3
"""Validate Quivra's pinned Architect installation and derived skill."""

import argparse
from pathlib import Path
import subprocess
import sys


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="Validate without changing files (the default).")
    parser.parse_args()

    root = Path(__file__).resolve().parents[2]
    checker = root / ".agents/skills/architect/scripts/check_inheritance.py"
    if not checker.is_file():
        print("Restore the pinned Architect dependency using the Skills CLI.", file=sys.stderr)
        return 1

    return subprocess.run(
        [sys.executable, str(checker), "--root", str(root), "--derived", "quivra-architect"],
        cwd=root,
        check=False,
    ).returncode


if __name__ == "__main__":
    raise SystemExit(main())
