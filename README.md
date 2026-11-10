# GitHub Agent Workflow

This repository contains the original Python bootstrap for a narrowly scoped
private GitHub App and a local TypeScript CLI for preparing an agent branch and
publishing it as a draft pull request. It does not create the App, install it,
change repository settings, or merge pull requests.

## Prerequisites

- Python 3.11 or newer
- `openssl` on `PATH`
- Node.js 24 or newer and Git on `PATH` (for the local PR CLI)
- A Moonbreeze owner who can create and install the private GitHub App

## Local setup

1. Follow the owner and operator procedure in
   [docs/github-app-bootstrap.md](docs/github-app-bootstrap.md).
2. Keep the downloaded key and the completed JSON configuration outside every
   Git repository, under
   `${XDG_CONFIG_HOME:-$HOME/.config}/github-agent-workflow/` by default.
3. Verify the installation:

   ```sh
   python3 scripts/verify-github-app-installation.py
   ```

   For an alternate configuration:

   ```sh
   python3 scripts/verify-github-app-installation.py --config PATH
   ```

4. Run a GitHub CLI command with a token present only in its child environment:

   ```sh
   python3 scripts/with-github-app-token.py -- gh repo view Moonbreeze/github-agent-workflow
   ```

Use `--config /absolute/path/config.json` before `--` to select a non-default
configuration. There is intentionally no token-printing mode.

Creating local directories and configuration files performs no network access.
Network access begins only when the operator separately invokes the verifier or
the command wrapper. The verifier issues one ephemeral-token `POST` followed by
inspection `GET` requests. The wrapper issues a token request, and its wrapped
child command may also use the network. Verification is an explicit preflight;
the command wrapper does not run it automatically.

## Local agent pull-request lifecycle

The TypeScript package is self-contained under `agent-cli/`:

```sh
cd agent-cli
npm install
npm run build
```

It uses the same documented configuration fields, fixed values, and credential
security rules as the Python bootstrap. The TypeScript CLI has not yet been
live-verified against GitHub; automated coverage is local/unit-level with
mocked API interactions. From the configured, allowlisted repository, prepare
a task branch:

```sh
npm run cli -- prepare --task issue-123 [--config PATH]
```

`prepare` requires a clean worktree and validates the configuration,
credentials, repository, exact HTTPS origin owner and allowlist, task, and
branch locally before contacting GitHub. It creates or switches only to
`agent/<task>`, retrieves the authenticated App identity, and sets
repository-local bot name and email values.

After committing the work, publish it:

```sh
npm run cli -- publish --title "Implement issue 123" --body-file ./pr-body.md [--config PATH]
```

`--body TEXT` may replace `--body-file`; they are mutually exclusive. `publish`
validates the clean worktree, allowlisted origin, and current `agent/<task>`
branch before authentication. It mints a short-lived token limited to the
configured repository with Metadata read, Contents write, and Pull requests
write; pushes only that branch to its canonical GitHub HTTPS URL with
process-scoped askpass authentication, credential helpers disabled, and
pre-push hooks bypassed; then creates a draft PR when none exists or updates
only the title and body of the sole existing open PR for that head. An existing
PR is not forcibly converted back to draft. Because the branch push occurs
before PR API creation or update, a later API failure may leave a pushed branch
without a PR; rerun `publish` to recover. GitHub's repository `default_branch`
is the PR base, including `main` or `master`.

JWTs and tokens are never printed or stored in Git configuration or credential
storage. Pushes to `main`, `master`, and non-agent branches are rejected. The
fetch origin must be HTTPS; SSH origins, separate push URLs, and Git URL
rewrites are rejected before authentication. Push authentication accepts only
the expected GitHub HTTPS username and password prompts.
The CLI has exactly `prepare` and `publish`: **it has no merge capability and no
arbitrary-command wrapper**. Review and merge remain human-controlled.

See [Workflow assurance modes](docs/workflow-assurance.md) for the distinction
between server-side enforcement and the accepted risks of trust-based use. The
live pilot is still in progress.
