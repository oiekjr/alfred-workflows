# Security Policy

## Trust model

This repository trusts a workflow obtained from its legitimate distribution channel, a GitHub CLI installation chosen by the user, and the user's macOS account.

A malicious process running as the same macOS user can modify the workflow, GitHub CLI, Keychain data, or Alfred settings. Defending against a process that already has those privileges is outside the workflow's security boundary.

## Security controls

- The workflow searches only fixed, standard locations for `gh`. It opens the executable with `O_NOFOLLOW`, verifies ownership and permissions, and copies the verified executable into a private cache that other accounts cannot modify.
- GitHub CLI runs without the parent environment. Only required values such as `HOME`, `PATH`, pager settings, and browser settings are set explicitly.
- Terminal authentication actions use a verified absolute helper path instead of a relative path. The path is Base64-encoded for safe transport to the fixed Terminal command.
- Projects integration requests only `read:project` and does not request Projects write access.
- Repository and Project lists are cached for five minutes only after authentication and API retrieval succeed. Each cache records the GitHub.com login and non-secret file identity metadata for the standard GitHub CLI configuration. A configuration change prevents data from the previous active account from being reused.
- List caches never store access tokens, GitHub CLI configuration contents, Alfred search text, or GitHub CLI standard error output. They are invalidated after an account configuration mismatch, expiry, an invalid format, or a workflow authentication action.
- URLs, JSON, image formats, image dimensions, response sizes, command output sizes, and execution times are validated or bounded.
- Avatar refresh runs asynchronously with a verified executable and fixed arguments. It does not inherit secrets from the parent process.
- Avatar files are downloaded directly from approved GitHub HTTPS hosts and stored in private directories and files with `0700` and `0600` permissions.
- Build and packaging tasks validate the pinned mise installation, ancestor symbolic links, ownership, shared-write permissions, versions, artifact contents, binary architectures, code signatures, and checksums.
- GitHub Actions dependencies are pinned to full commit hashes. The release workflow validates the tag against `info.plist` and separates read-only repository access plus attestation-specific permissions from the release job's `contents: write` permission.

## Artifact assurance

The generated SHA-256 checksum and ad hoc code signature help detect corruption or unintended replacement. The release workflow also generates a GitHub artifact attestation that binds the packaged workflow to its source repository, tagged commit, and workflow run.

The attestation provides signed build provenance but does not replace Apple Developer ID signing or notarization. The ad hoc code signature alone does not prove the publisher's identity.

## Report a vulnerability

Do not include credentials, private repository information, or exploit secrets in a public issue.

To report a vulnerability:

1. Open [GitHub Private vulnerability reporting](https://github.com/oiekjr/alfred-workflows/security/advisories/new).
2. Describe the conditions required to reproduce the issue.
3. Explain the affected scope and expected impact.
4. Include the smallest useful reproduction steps with all secrets removed.

Use private reporting for issues involving authentication data, private repository information, or arbitrary command execution.
