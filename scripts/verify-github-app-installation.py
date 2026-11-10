#!/usr/bin/env python3
"""Verify via ephemeral token issuance followed by read-only inspection."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from github_agent_workflow.github_app import BootstrapError, load_config, verify_installation


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(allow_abbrev=False)
    parser.add_argument("--config")
    try:
        options = parser.parse_args(argv)
        summary = verify_installation(load_config(options.config))
    except BootstrapError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    print(f"Owner: {summary['owner']}")
    print(f"Repository selection: {summary['repository_selection']}")
    print("Repositories: " + ", ".join(summary["repositories"]))
    print("Permissions: " + json.dumps(summary["permissions"], sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
