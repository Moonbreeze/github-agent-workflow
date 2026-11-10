# Workflow assurance modes

This workflow can operate with either of two different assurance modes. They
must not be described as equivalent.

## Enforced

In enforced mode, GitHub branch protection or a repository ruleset provides a
server-side boundary. GitHub rejects direct pushes to the protected branch,
requires changes to arrive through a pull request, and requires an independent
review before merge.

## Trust-based

For private repositories on GitHub Free where the required server-side
protection is unavailable, the workflow is trust-based. The local CLI and the
operator procedure reduce the risk of accidental mistakes, but they are not a
security boundary. They cannot guarantee that a direct push will be rejected
when an actor has access to the GitHub App private key or a token.

The absence of server-side protection must be reported explicitly as an
accepted risk. It must not be presented as equivalent to a protected branch.

## Current CLI safeguards

The CLI currently provides these local safeguards:

- requires the exact configured GitHub HTTPS origin;
- restricts operation to repositories on the configured allowlist;
- prepares and publishes only `agent/*` branches;
- guards protected branches such as `main` and `master` from pushes;
- mints a short-lived token scoped to the configured repository and required
  permissions;
- creates pull requests as drafts;
- provides no merge command; and
- does not persist the token in Git configuration or credential storage.

These safeguards reduce accidental misuse but do not replace server-side
enforcement. The live pilot is still in progress.
