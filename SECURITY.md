# Security Policy

## Trust model

This repository trusts a workflow obtained from its legitimate distribution channel, Node.js and GitHub CLI installations chosen by the user, and the user's macOS account.

A malicious process running as the same macOS user can modify the workflow, Node.js, GitHub CLI, Keychain data, or Alfred settings. Defending against a process that already has those privileges is outside the workflow's security boundary.

## Security controls

- The workflow searches only fixed, standard locations for `gh`. It opens the executable with `O_NOFOLLOW`, verifies ownership and permissions, and copies the verified executable into a private cache that other accounts cannot modify.
- The packaged `github-repositories` file is non-executable shell source passed explicitly to `/bin/sh`. It resolves Node.js 22 or later only from fixed Homebrew, MacPorts, and `/usr/local` locations, then launches packaged `.mjs` source with a newly constructed minimal environment.
- GitHub CLI runs without the parent environment. Only required values such as `HOME`, `PATH`, pager settings, and browser settings are set explicitly.
- Terminal authentication actions use a verified absolute launcher-source path instead of a relative path. The path is Base64-encoded for safe transport to a fixed `/bin/sh` Terminal command.
- Projects integration requests only `read:project` and does not request Projects write access.
- Repository and Project lists are cached for 30 minutes only after authentication and API retrieval succeed. Each cache records the GitHub.com login and non-secret file identity metadata for the standard GitHub CLI configuration. A configuration change prevents data from the previous active account from being reused.
- List caches never store access tokens, GitHub CLI configuration contents, Alfred search text, or GitHub CLI standard error output. They are invalidated after an account configuration mismatch, expiry, an invalid format, or a workflow authentication action.
- URLs, JSON, image formats, image dimensions, response sizes, command output sizes, and execution times are validated or bounded.
- Avatar refresh runs asynchronously with a verified launcher source and fixed arguments. It does not inherit secrets from the parent process.
- Avatar files are downloaded directly from approved GitHub HTTPS hosts and stored in private directories and files with `0700` and `0600` permissions.
- Build and packaging tasks validate the pinned mise installation, ancestor symbolic links, ownership, shared-write permissions, versions, exact artifact contents, absence of bundled Mach-O files, and checksums.
- GitHub Actions dependencies are pinned to full commit hashes. The release workflow derives the release tag from the validated `info.plist` version, rejects conflicting release state, and separates read-only repository access plus attestation-specific permissions from the release job's `contents: write` permission.

## Artifact assurance

The generated SHA-256 checksum helps detect corruption or unintended replacement. The release workflow also generates a GitHub artifact attestation that binds the packaged workflow to its source repository, commit, and workflow run. The published release tag points to that same commit.

The artifact contains interpreted shell and Node.js source rather than a native Mach-O executable, so the workflow does not rely on ad hoc signing, Apple Developer ID signing, or notarization. The attestation provides signed build provenance for the source package; separately installed Node.js and GitHub CLI executables retain their own distribution and signing boundaries.

## Report a vulnerability

Do not include credentials, private repository information, or exploit secrets in a public issue.

To report a vulnerability:

1. Open [GitHub Private vulnerability reporting](https://github.com/oiekjr/alfred-workflows/security/advisories/new).
2. Describe the conditions required to reproduce the issue.
3. Explain the affected scope and expected impact.
4. Include the smallest useful reproduction steps with all secrets removed.

Use private reporting for issues involving authentication data, private repository information, or arbitrary command execution.
