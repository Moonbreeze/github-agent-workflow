"""Secure, standard-library-only GitHub App authentication and verification."""

from __future__ import annotations

import base64
import json
import os
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
import stat
import subprocess
import time
from typing import Any, Callable
import urllib.error
import urllib.request


API_BASE = "https://api.github.com"
EXPECTED_OWNER = "Moonbreeze"
EXPECTED_REPOSITORIES = ("github-agent-workflow",)
EXPECTED_PERMISSIONS = {
    "metadata": "read",
    "contents": "write",
    "pull_requests": "write",
}
CONFIG_KEYS = {
    "app_id",
    "installation_id",
    "expected_owner",
    "allowed_repositories",
    "private_key_path",
}


class BootstrapError(Exception):
    """A sanitized, user-displayable bootstrap failure."""


@dataclass(frozen=True)
class Config:
    app_id: int
    installation_id: int
    expected_owner: str
    allowed_repositories: tuple[str, ...]
    private_key_path: Path
    path: Path


class TokenPurpose(Enum):
    """The two deliberately distinct installation-token privilege sets."""

    COMMAND = "command"
    VERIFICATION = "verification"


def default_config_path() -> Path:
    base = os.environ.get("XDG_CONFIG_HOME")
    config_home = Path(base).expanduser() if base else Path.home() / ".config"
    return config_home / "github-agent-workflow" / "config.json"


def _credential_stat(path: Path, required: int, kind: str, *, directory: bool) -> None:
    try:
        info = path.lstat()
    except OSError:
        raise BootstrapError(f"Required local {kind} is unavailable") from None
    if stat.S_ISLNK(info.st_mode):
        raise BootstrapError(f"Local {kind} must not be a symbolic link")
    if directory:
        if not stat.S_ISDIR(info.st_mode):
            raise BootstrapError(f"Local {kind} must be a directory")
    elif not stat.S_ISREG(info.st_mode):
        raise BootstrapError(f"Local {kind} must be a regular file")
    elif info.st_nlink != 1:
        raise BootstrapError(f"Local {kind} must not have multiple hard links")
    actual = stat.S_IMODE(info.st_mode)
    if actual != required:
        raise BootstrapError(
            f"Insecure {kind} mode: expected {required:04o}, found {actual:04o}"
        )


def _absolute_lexical(path: Path) -> Path:
    """Make a path absolute without resolving or normalizing its components."""

    return path if path.is_absolute() else Path.cwd() / path


def _reject_symlink_components(path: Path, kind: str) -> None:
    current = Path(path.anchor)
    for component in path.parts[1:]:
        current = current / component
        try:
            info = current.lstat()
        except OSError:
            raise BootstrapError(f"Required local {kind} is unavailable") from None
        if stat.S_ISLNK(info.st_mode):
            raise BootstrapError(f"Local {kind} path must not contain symbolic links")


def _git_root_containing(path: Path, *, canonicalize: bool = True) -> Path | None:
    current = path.resolve() if canonicalize else path
    if not current.is_dir():
        current = current.parent
    for candidate in (current, *current.parents):
        if (candidate / ".git").exists():
            return candidate
        if (
            (candidate / "HEAD").is_file()
            and (candidate / "objects").is_dir()
            and (candidate / "refs").is_dir()
        ):
            return candidate
    return None


def _validate_outside_git(
    path: Path,
    label: str,
    current_worktree: Path | None,
    *,
    canonicalize: bool,
) -> None:
    location = path.resolve() if canonicalize else path
    if current_worktree is not None:
        try:
            location.relative_to(current_worktree.resolve())
        except ValueError:
            pass
        else:
            raise BootstrapError(f"{label} must not be inside the current Git worktree")
    if _git_root_containing(location, canonicalize=False) is not None:
        raise BootstrapError(f"{label} must be outside all Git repositories")


def load_config(path: Path | str | None = None, *, cwd: Path | None = None) -> Config:
    config_path = Path(path) if path is not None else default_config_path()
    config_path = _absolute_lexical(config_path.expanduser())
    current_root = _git_root_containing(cwd or Path.cwd())

    _reject_symlink_components(config_path, "config file")
    _credential_stat(config_path.parent, 0o700, "credential directory", directory=True)
    _credential_stat(config_path, 0o600, "config file", directory=False)
    canonical_config_path = config_path.resolve()
    _validate_outside_git(
        config_path, "Config file", current_root, canonicalize=False
    )
    _validate_outside_git(
        canonical_config_path, "Config file", current_root, canonicalize=True
    )
    try:
        raw = json.loads(config_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        raise BootstrapError("Config file is not readable valid JSON") from None
    if not isinstance(raw, dict) or set(raw) != CONFIG_KEYS:
        raise BootstrapError("Config must contain exactly the documented fields")

    for name in ("app_id", "installation_id"):
        value = raw[name]
        if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
            raise BootstrapError(f"Config field {name} must be a positive integer")
    if raw["expected_owner"] != EXPECTED_OWNER:
        raise BootstrapError(f"Config expected_owner must be {EXPECTED_OWNER}")
    repositories = raw["allowed_repositories"]
    if (
        not isinstance(repositories, list)
        or any(not isinstance(item, str) for item in repositories)
        or tuple(repositories) != EXPECTED_REPOSITORIES
    ):
        raise BootstrapError(
            "Config allowed_repositories must contain only github-agent-workflow"
        )
    key_value = raw["private_key_path"]
    if not isinstance(key_value, str) or not key_value or not Path(key_value).is_absolute():
        raise BootstrapError("Config private_key_path must be a non-empty absolute path")
    key_path = _absolute_lexical(Path(key_value).expanduser())
    _reject_symlink_components(key_path, "private key")
    _credential_stat(key_path.parent, 0o700, "private-key directory", directory=True)
    _credential_stat(key_path, 0o600, "private key", directory=False)
    canonical_key_path = key_path.resolve()
    _validate_outside_git(
        key_path, "Private key", current_root, canonicalize=False
    )
    _validate_outside_git(
        canonical_key_path, "Private key", current_root, canonicalize=True
    )
    return Config(
        app_id=raw["app_id"],
        installation_id=raw["installation_id"],
        expected_owner=raw["expected_owner"],
        allowed_repositories=tuple(repositories),
        private_key_path=canonical_key_path,
        path=canonical_config_path,
    )


def _b64url(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def create_jwt(
    config: Config,
    *,
    now: int | None = None,
    runner: Callable[..., subprocess.CompletedProcess[bytes]] = subprocess.run,
) -> str:
    issued = int(time.time()) if now is None else now
    header = _b64url(json.dumps({"alg": "RS256", "typ": "JWT"}, separators=(",", ":")).encode())
    payload = _b64url(
        json.dumps(
            {"iat": issued - 60, "exp": issued + 540, "iss": config.app_id},
            separators=(",", ":"),
        ).encode()
    )
    signing_input = f"{header}.{payload}".encode("ascii")
    try:
        result = runner(
            ["openssl", "dgst", "-sha256", "-sign", os.fspath(config.private_key_path)],
            input=signing_input,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        raise BootstrapError("Unable to run openssl to sign the GitHub App JWT") from None
    if result.returncode != 0 or not result.stdout:
        raise BootstrapError("openssl could not sign the GitHub App JWT")
    return f"{signing_input.decode('ascii')}.{_b64url(result.stdout)}"


def api_request(
    method: str,
    path: str,
    auth_token: str,
    *,
    payload: dict[str, Any] | None = None,
    opener: Callable[..., Any] | None = None,
) -> dict[str, Any]:
    if not path.startswith("/"):
        raise BootstrapError("Invalid internal GitHub API path")
    body = None if payload is None else json.dumps(payload, separators=(",", ":")).encode()
    headers = {
        "Accept": "application/vnd.github+json",
        "Authorization": f"Bearer {auth_token}",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "github-agent-workflow-bootstrap",
    }
    if body is not None:
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(API_BASE + path, data=body, headers=headers, method=method)
    open_request = opener or urllib.request.urlopen
    try:
        with open_request(request, timeout=30) as response:
            response_body = response.read()
    except urllib.error.HTTPError as exc:
        raise BootstrapError(f"GitHub API request failed (HTTP {exc.code})") from None
    except (urllib.error.URLError, OSError, TimeoutError):
        raise BootstrapError("GitHub API request failed (network error)") from None
    try:
        decoded = json.loads(response_body)
    except (UnicodeError, json.JSONDecodeError):
        raise BootstrapError("GitHub API returned an invalid response") from None
    if not isinstance(decoded, dict):
        raise BootstrapError("GitHub API returned an invalid response")
    return decoded


def mint_installation_token(
    config: Config,
    *,
    purpose: TokenPurpose,
    jwt: str | None = None,
    request: Callable[..., dict[str, Any]] = api_request,
) -> str:
    app_jwt = jwt if jwt is not None else create_jwt(config)
    if purpose is TokenPurpose.COMMAND:
        payload = {
            "repositories": list(config.allowed_repositories),
            "permissions": dict(EXPECTED_PERMISSIONS),
        }
    elif purpose is TokenPurpose.VERIFICATION:
        payload = {"permissions": {"metadata": "read"}}
    else:
        raise BootstrapError("Invalid internal installation-token purpose")
    response = request(
        "POST",
        f"/app/installations/{config.installation_id}/access_tokens",
        app_jwt,
        payload=payload,
    )
    token = response.get("token")
    if not isinstance(token, str) or not token:
        raise BootstrapError("GitHub API did not return an installation token")
    return token


def run_with_token(
    config: Config,
    command: list[str],
    *,
    token_factory: Callable[..., str] = mint_installation_token,
    runner: Callable[..., subprocess.CompletedProcess[Any]] = subprocess.run,
) -> int:
    if not command:
        raise BootstrapError("A command is required after --")
    token = token_factory(config, purpose=TokenPurpose.COMMAND)
    child_environment = os.environ.copy()
    child_environment["GH_TOKEN"] = token
    child_environment["GITHUB_TOKEN"] = token
    try:
        result = runner(command, env=child_environment, check=False)
    except OSError:
        raise BootstrapError("Unable to execute the requested command") from None
    return result.returncode


def _permission_map(value: Any, endpoint: str) -> dict[str, str]:
    if not isinstance(value, dict) or any(
        not isinstance(key, str) or not isinstance(level, str)
        for key, level in value.items()
    ):
        raise BootstrapError(f"GitHub {endpoint} response has no valid permission map")
    return value


def verify_installation(
    config: Config,
    *,
    jwt: str | None = None,
    token: str | None = None,
    request: Callable[..., dict[str, Any]] = api_request,
) -> dict[str, Any]:
    app_jwt = jwt if jwt is not None else create_jwt(config)
    installation_token = token if token is not None else mint_installation_token(
        config, purpose=TokenPurpose.VERIFICATION, jwt=app_jwt, request=request
    )
    app = request("GET", "/app", app_jwt)
    installation = request(
        "GET", f"/app/installations/{config.installation_id}", app_jwt
    )
    repositories_response = request(
        "GET", "/installation/repositories", installation_token
    )

    app_owner = app.get("owner")
    installation_account = installation.get("account")
    if not isinstance(app_owner, dict) or app_owner.get("login") != config.expected_owner:
        raise BootstrapError("GitHub App owner does not match configured owner")
    if (
        not isinstance(installation_account, dict)
        or installation_account.get("login") != config.expected_owner
    ):
        raise BootstrapError("GitHub installation owner does not match configured owner")
    if installation.get("repository_selection") != "selected":
        raise BootstrapError("GitHub installation is not in selected-repositories mode")

    app_permissions = _permission_map(app.get("permissions"), "App")
    installation_permissions = _permission_map(
        installation.get("permissions"), "installation"
    )
    if app_permissions != EXPECTED_PERMISSIONS:
        raise BootstrapError("GitHub App permissions do not exactly match bootstrap permissions")
    if installation_permissions != EXPECTED_PERMISSIONS:
        raise BootstrapError(
            "GitHub installation permissions do not exactly match bootstrap permissions"
        )

    repositories = repositories_response.get("repositories")
    total_count = repositories_response.get("total_count")
    if not isinstance(repositories, list) or isinstance(total_count, bool) or not isinstance(total_count, int):
        raise BootstrapError("GitHub repository response is invalid")
    full_names: list[str] = []
    for repository in repositories:
        if not isinstance(repository, dict) or not isinstance(repository.get("full_name"), str):
            raise BootstrapError("GitHub repository response is invalid")
        full_names.append(repository["full_name"])
    expected_full_names = [
        f"{config.expected_owner}/{name}" for name in config.allowed_repositories
    ]
    if total_count != len(repositories) or sorted(full_names) != sorted(expected_full_names):
        raise BootstrapError("Accessible repositories do not exactly match configured allowlist")
    return {
        "owner": config.expected_owner,
        "repository_selection": "selected",
        "repositories": sorted(full_names),
        "permissions": dict(EXPECTED_PERMISSIONS),
    }
