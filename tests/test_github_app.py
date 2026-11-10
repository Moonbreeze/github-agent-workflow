from __future__ import annotations

import io
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import urllib.error
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from github_agent_workflow.github_app import (
    API_BASE,
    BootstrapError,
    Config,
    EXPECTED_PERMISSIONS,
    TokenPurpose,
    api_request,
    create_jwt,
    load_config,
    mint_installation_token,
    run_with_token,
    verify_installation,
)


class ConfigFixture(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.credentials = self.root / "credentials"
        self.credentials.mkdir(mode=0o700)
        self.key = self.credentials / "app.pem"
        self.key.write_text("not-a-real-private-key", encoding="utf-8")
        self.key.chmod(0o600)
        self.config_path = self.credentials / "config.json"
        self.data = {
            "app_id": 123,
            "installation_id": 456,
            "expected_owner": "Moonbreeze",
            "allowed_repositories": ["github-agent-workflow"],
            "private_key_path": str(self.key),
        }
        self.write_config()
        self.cwd = self.root / "working"
        self.cwd.mkdir()

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def write_config(self) -> None:
        self.config_path.write_text(json.dumps(self.data), encoding="utf-8")
        self.config_path.chmod(0o600)

    def load(self) -> Config:
        return load_config(self.config_path, cwd=self.cwd)


class ConfigTests(ConfigFixture):
    def test_valid_strict_config(self) -> None:
        config = self.load()
        self.assertEqual(config.app_id, 123)
        self.assertEqual(config.allowed_repositories, ("github-agent-workflow",))

    def test_rejects_extra_field_wrong_type_owner_and_allowlist(self) -> None:
        valid = dict(self.data)
        bad_values = (
            ("extra", {**valid, "extra": True}),
            ("type", {**valid, "app_id": "123"}),
            ("owner", {**valid, "expected_owner": "SomeoneElse"}),
            ("repositories", {**valid, "allowed_repositories": ["other"]}),
        )
        for name, value in bad_values:
            with self.subTest(name=name):
                self.data = value
                self.write_config()
                with self.assertRaises(BootstrapError):
                    self.load()

    def test_rejects_insecure_modes(self) -> None:
        cases = ((self.credentials, 0o755), (self.config_path, 0o644), (self.key, 0o644))
        for path, bad_mode in cases:
            with self.subTest(path=path.name):
                original = path.stat().st_mode & 0o777
                path.chmod(bad_mode)
                try:
                    with self.assertRaisesRegex(BootstrapError, "Insecure"):
                        self.load()
                finally:
                    path.chmod(original)

    def test_rejects_key_inside_current_git_worktree(self) -> None:
        worktree = self.root / "repository"
        worktree.mkdir()
        (worktree / ".git").mkdir()
        key = worktree / "app.pem"
        key.write_text("secret", encoding="utf-8")
        key.chmod(0o600)
        worktree.chmod(0o700)
        self.data["private_key_path"] = str(key)
        self.write_config()
        with self.assertRaisesRegex(BootstrapError, "current Git worktree"):
            load_config(self.config_path, cwd=worktree)

    def test_rejects_config_and_key_symlinks(self) -> None:
        config_target = self.credentials / "config-target.json"
        self.config_path.rename(config_target)
        self.config_path.symlink_to(config_target)
        with self.assertRaisesRegex(BootstrapError, "symbolic link"):
            self.load()

        self.config_path.unlink()
        config_target.rename(self.config_path)
        key_target = self.credentials / "key-target.pem"
        self.key.rename(key_target)
        self.key.symlink_to(key_target)
        with self.assertRaisesRegex(BootstrapError, "symbolic link"):
            self.load()

    def test_rejects_symlinked_credential_directories(self) -> None:
        real_directory = self.root / "real-credentials"
        self.credentials.rename(real_directory)
        self.credentials.symlink_to(real_directory, target_is_directory=True)
        with self.assertRaisesRegex(BootstrapError, "symbolic link"):
            self.load()

    def test_rejects_intermediate_config_symlink_inside_worktree(self) -> None:
        worktree = self.root / "config-worktree"
        worktree.mkdir()
        (worktree / ".git").mkdir()
        target_root = self.root / "external-config-root"
        target_root.mkdir()
        target_directory = target_root / "nested"
        target_directory.mkdir(mode=0o700)
        target_config = target_directory / "config.json"
        target_config.write_text(json.dumps(self.data), encoding="utf-8")
        target_config.chmod(0o600)
        (worktree / "alias").symlink_to(target_root, target_is_directory=True)

        lexical_config = worktree / "alias" / "nested" / "config.json"
        with self.assertRaisesRegex(BootstrapError, "symbolic links"):
            load_config(lexical_config, cwd=worktree)

    def test_rejects_intermediate_key_symlink_inside_worktree(self) -> None:
        worktree = self.root / "key-worktree"
        worktree.mkdir()
        (worktree / ".git").write_text("gitdir: /elsewhere/worktrees/key\n", encoding="utf-8")
        target_root = self.root / "external-key-root"
        target_root.mkdir()
        target_directory = target_root / "nested"
        target_directory.mkdir(mode=0o700)
        target_key = target_directory / "app.pem"
        target_key.write_text("secret", encoding="utf-8")
        target_key.chmod(0o600)
        (worktree / "alias").symlink_to(target_root, target_is_directory=True)
        self.data["private_key_path"] = str(
            worktree / "alias" / "nested" / "app.pem"
        )
        self.write_config()

        with self.assertRaisesRegex(BootstrapError, "symbolic links"):
            self.load()

    def test_rejects_intermediate_symlink_outside_repository(self) -> None:
        target_root = self.root / "non-repository-target"
        target_root.mkdir()
        target_directory = target_root / "nested"
        target_directory.mkdir(mode=0o700)
        target_config = target_directory / "config.json"
        target_config.write_text(json.dumps(self.data), encoding="utf-8")
        target_config.chmod(0o600)
        alias_root = self.root / "non-repository-alias"
        alias_root.mkdir()
        (alias_root / "link").symlink_to(target_root, target_is_directory=True)

        lexical_config = alias_root / "link" / "nested" / "config.json"
        with self.assertRaisesRegex(BootstrapError, "symbolic links"):
            load_config(lexical_config, cwd=self.cwd)

    def test_rejects_fifo_config_without_reading_and_fifo_key(self) -> None:
        self.config_path.unlink()
        os.mkfifo(self.config_path, mode=0o600)
        with self.assertRaisesRegex(BootstrapError, "regular file"):
            self.load()

        self.config_path.unlink()
        self.write_config()
        self.key.unlink()
        os.mkfifo(self.key, mode=0o600)
        with self.assertRaisesRegex(BootstrapError, "regular file"):
            self.load()

    def test_rejects_hard_linked_config_and_key(self) -> None:
        config_link = self.credentials / "config-link.json"
        os.link(self.config_path, config_link)
        with self.assertRaisesRegex(BootstrapError, "hard links"):
            self.load()
        config_link.unlink()

        key_link = self.credentials / "key-link.pem"
        os.link(self.key, key_link)
        with self.assertRaisesRegex(BootstrapError, "hard links"):
            self.load()

    def _assert_key_rejected_in_repository(self, repository: Path) -> None:
        credential_directory = repository / "credentials"
        credential_directory.mkdir(mode=0o700)
        key = credential_directory / "app.pem"
        key.write_text("secret", encoding="utf-8")
        key.chmod(0o600)
        self.data["private_key_path"] = str(key)
        self.write_config()
        with self.assertRaisesRegex(BootstrapError, "Git repositories"):
            self.load()

    def test_rejects_key_in_linked_worktree_style_repository(self) -> None:
        repository = self.root / "linked-worktree"
        repository.mkdir()
        (repository / ".git").write_text("gitdir: /elsewhere/worktrees/example\n", encoding="utf-8")
        self._assert_key_rejected_in_repository(repository)

    def test_rejects_key_in_bare_repository(self) -> None:
        repository = self.root / "bare.git"
        repository.mkdir()
        (repository / "HEAD").write_text("ref: refs/heads/main\n", encoding="utf-8")
        (repository / "objects").mkdir()
        (repository / "refs").mkdir()
        self._assert_key_rejected_in_repository(repository)


class AuthenticationTests(unittest.TestCase):
    def config(self, key: Path = Path("/secure/app.pem")) -> Config:
        return Config(123, 456, "Moonbreeze", ("github-agent-workflow",), key, Path("/secure/config.json"))

    def test_jwt_request_to_openssl_and_no_secret_output(self) -> None:
        private_key_contents = "PRIVATE-KEY-CONTENTS"
        runner = mock.Mock(
            return_value=subprocess.CompletedProcess([], 0, stdout=b"binary-signature", stderr=b"")
        )
        stdout = io.StringIO()
        stderr = io.StringIO()
        with mock.patch("sys.stdout", stdout), mock.patch("sys.stderr", stderr):
            jwt = create_jwt(self.config(), now=1_000, runner=runner)
        args, kwargs = runner.call_args
        self.assertEqual(args[0][:4], ["openssl", "dgst", "-sha256", "-sign"])
        self.assertEqual(kwargs["input"].count(b"."), 1)
        self.assertEqual(jwt.count("."), 2)
        self.assertNotIn(private_key_contents, jwt)
        self.assertEqual(stdout.getvalue(), "")
        self.assertEqual(stderr.getvalue(), "")

    def test_command_installation_token_request_construction(self) -> None:
        request = mock.Mock(return_value={"token": "installation-secret"})
        token = mint_installation_token(
            self.config(), purpose=TokenPurpose.COMMAND, jwt="app-jwt-secret", request=request
        )
        self.assertEqual(token, "installation-secret")
        request.assert_called_once_with(
            "POST",
            "/app/installations/456/access_tokens",
            "app-jwt-secret",
            payload={
                "repositories": ["github-agent-workflow"],
                "permissions": dict(EXPECTED_PERMISSIONS),
            },
        )

    def test_verification_token_request_has_metadata_only_and_no_restriction(self) -> None:
        request = mock.Mock(return_value={"token": "installation-secret"})
        mint_installation_token(
            self.config(),
            purpose=TokenPurpose.VERIFICATION,
            jwt="app-jwt-secret",
            request=request,
        )
        request.assert_called_once_with(
            "POST",
            "/app/installations/456/access_tokens",
            "app-jwt-secret",
            payload={"permissions": {"metadata": "read"}},
        )

    def test_api_request_headers_and_body(self) -> None:
        response = mock.MagicMock()
        response.__enter__.return_value.read.return_value = b'{"token":"secret"}'
        opener = mock.Mock(return_value=response)
        result = api_request("POST", "/app/installations/456/access_tokens", "jwt", payload={}, opener=opener)
        request = opener.call_args.args[0]
        self.assertEqual(request.full_url, API_BASE + "/app/installations/456/access_tokens")
        self.assertEqual(request.method, "POST")
        self.assertEqual(request.get_header("Authorization"), "Bearer jwt")
        self.assertEqual(request.data, b"{}")
        self.assertEqual(result["token"], "secret")

    def test_child_environment_injection_does_not_mutate_parent(self) -> None:
        observed: dict[str, object] = {}

        def runner(command, **kwargs):
            observed["command"] = command
            observed["env"] = kwargs["env"]
            return subprocess.CompletedProcess(command, 7)

        before_gh = os.environ.get("GH_TOKEN")
        before_github = os.environ.get("GITHUB_TOKEN")
        result = run_with_token(
            self.config(),
            ["tool", "arg"],
            token_factory=lambda unused, *, purpose: (
                "child-secret" if purpose is TokenPurpose.COMMAND else "wrong-secret"
            ),
            runner=runner,
        )
        self.assertEqual(result, 7)
        self.assertEqual(observed["command"], ["tool", "arg"])
        self.assertEqual(observed["env"]["GH_TOKEN"], "child-secret")
        self.assertEqual(observed["env"]["GITHUB_TOKEN"], "child-secret")
        self.assertEqual(os.environ.get("GH_TOKEN"), before_gh)
        self.assertEqual(os.environ.get("GITHUB_TOKEN"), before_github)

    def test_api_errors_are_sanitized(self) -> None:
        secret = "server-leaked-secret"
        error = urllib.error.HTTPError(
            API_BASE + "/app", 401, f"bad {secret}", {}, io.BytesIO(secret.encode())
        )
        with self.assertRaises(BootstrapError) as caught:
            api_request("GET", "/app", "jwt-secret", opener=mock.Mock(side_effect=error))
        message = str(caught.exception)
        self.assertEqual(message, "GitHub API request failed (HTTP 401)")
        self.assertNotIn(secret, message)
        self.assertNotIn("jwt-secret", message)


class VerificationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.config = Config(
            123,
            456,
            "Moonbreeze",
            ("github-agent-workflow",),
            Path("/secure/app.pem"),
            Path("/secure/config.json"),
        )
        self.responses = {
            "/app": {
                "owner": {"login": "Moonbreeze"},
                "permissions": dict(EXPECTED_PERMISSIONS),
            },
            "/app/installations/456": {
                "account": {"login": "Moonbreeze"},
                "repository_selection": "selected",
                "permissions": dict(EXPECTED_PERMISSIONS),
            },
            "/installation/repositories": {
                "total_count": 1,
                "repositories": [{"full_name": "Moonbreeze/github-agent-workflow"}],
            },
        }

    def request(self, method, path, auth, **kwargs):
        if method == "POST":
            return {"token": "token-secret"}
        return self.responses[path]

    def verify(self):
        return verify_installation(
            self.config, jwt="jwt-secret", token="token-secret", request=self.request
        )

    def test_realistic_app_response_without_public_field_succeeds(self) -> None:
        self.assertNotIn("public", self.responses["/app"])
        summary = self.verify()
        rendered = json.dumps(summary)
        self.assertEqual(summary["owner"], "Moonbreeze")
        self.assertNotIn("jwt-secret", rendered)
        self.assertNotIn("token-secret", rendered)

    def test_owner_failure(self) -> None:
        self.responses["/app"]["owner"]["login"] = "Other"
        with self.assertRaisesRegex(BootstrapError, "owner"):
            self.verify()

    def test_allowlist_failure(self) -> None:
        self.responses["/installation/repositories"] = {
            "total_count": 2,
            "repositories": [
                {"full_name": "Moonbreeze/github-agent-workflow"},
                {"full_name": "Moonbreeze/extra"},
            ],
        }
        with self.assertRaisesRegex(BootstrapError, "allowlist"):
            self.verify()

    def test_verification_mints_unrestricted_metadata_token_before_repository_check(self) -> None:
        calls = []

        def request(method, path, auth, **kwargs):
            calls.append((method, path, kwargs))
            if method == "POST":
                return {"token": "verification-secret"}
            return self.responses[path]

        verify_installation(self.config, jwt="jwt-secret", request=request)
        self.assertEqual(calls[0][0], "POST")
        self.assertIn(
            (
                "POST",
                "/app/installations/456/access_tokens",
                {"payload": {"permissions": {"metadata": "read"}}},
            ),
            calls,
        )

    def test_permission_failures_include_checks_and_forbidden_permission(self) -> None:
        for extra in ("checks", "administration", "secrets", "members", "workflows"):
            with self.subTest(extra=extra):
                self.responses["/app"]["permissions"] = {
                    **EXPECTED_PERMISSIONS,
                    extra: "read" if extra != "administration" else "write",
                }
                with self.assertRaisesRegex(BootstrapError, "permissions"):
                    self.verify()

    def test_required_permission_level_failure(self) -> None:
        self.responses["/app/installations/456"]["permissions"]["contents"] = "read"
        with self.assertRaisesRegex(BootstrapError, "permissions"):
            self.verify()

    def test_selected_mode_failure(self) -> None:
        self.responses["/app/installations/456"]["repository_selection"] = "all"
        with self.assertRaisesRegex(BootstrapError, "selected-repositories"):
            self.verify()


def _load_script(name: str, filename: str):
    path = Path(__file__).resolve().parents[1] / "scripts" / filename
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class CliTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.command_script = _load_script("with_github_app_token_script", "with-github-app-token.py")
        cls.verify_script = _load_script(
            "verify_github_app_installation_script", "verify-github-app-installation.py"
        )

    def test_command_rejects_abbreviated_and_unknown_options(self) -> None:
        for option in ("--conf", "--unknown"):
            with self.subTest(option=option), mock.patch("sys.stderr", io.StringIO()):
                with self.assertRaises(BootstrapError):
                    self.command_script._arguments([option, "/tmp/config", "--", "tool"])

    def test_verifier_rejects_abbreviated_and_unknown_options(self) -> None:
        for option in ("--conf", "--unknown"):
            with self.subTest(option=option), mock.patch("sys.stderr", io.StringIO()):
                with self.assertRaises(SystemExit) as caught:
                    self.verify_script.main([option, "/tmp/config"])
                self.assertEqual(caught.exception.code, 2)


if __name__ == "__main__":
    unittest.main()
