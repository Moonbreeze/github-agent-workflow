#!/usr/bin/env python3
"""Run one command with a short-lived GitHub App installation token."""

from __future__ import annotations

import argparse
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from github_agent_workflow.github_app import BootstrapError, load_config, run_with_token


def _arguments(argv: list[str]) -> tuple[str | None, list[str]]:
    if "--" not in argv:
        raise BootstrapError("Usage: with-github-app-token.py [--config PATH] -- COMMAND [ARGS...]")
    separator = argv.index("--")
    parser = argparse.ArgumentParser(add_help=False, allow_abbrev=False)
    parser.add_argument("--config")
    try:
        options = parser.parse_args(argv[:separator])
    except SystemExit:
        raise BootstrapError("Only --config PATH is accepted before --") from None
    command = argv[separator + 1 :]
    if not command:
        raise BootstrapError("A command is required after --")
    return options.config, command


def main(argv: list[str] | None = None) -> int:
    try:
        config_path, command = _arguments(sys.argv[1:] if argv is None else argv)
        return run_with_token(load_config(config_path), command)
    except BootstrapError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
