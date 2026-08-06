# Repository Instructions

## Scope and privacy

These instructions apply to the entire repository.

- Keep this public file limited to instructions that are specific to this repository.
- Do not quote, summarize, or copy instructions from user-level, machine-local, or other higher-scope `AGENTS.md` files.
- Do not add personal interaction preferences, general writing rules, or unrelated Git conventions.

## Documentation

- Write public repository documentation in English.
- Keep README files task-oriented and structured as How-to guides.
- Put AI-specific repository instructions in this file instead of user-facing README files.

## Tooling and dependencies

- Manage language and tool versions with mise.
- Do not add a language, toolchain, or npm dependency without prior agreement.
- Keep GitHub Navigator on Node.js standard-library modules only.

## Repository invariants

- Preserve the repository as a collection of independently implemented, documented, versioned, and packaged Alfred workflows.
- Preserve GitHub Navigator's `gh` keyword, `com.oiekjr.alfred.github-repositories` bundle ID, `workflows/github-repositories` directory, `github-repositories` executable name, and `github-repositories-<version>.alfredworkflow` artifact name unless an explicitly approved compatibility plan says otherwise.
- Preserve the authentication, URL validation, secret-handling, private-cache, restricted-environment, and fixed-argument controls documented in `SECURITY.md`.
- Obtain explicit approval before running authentication or API checks against a real GitHub account.

## Verification

- Run `mise run check` for repository changes.
- Also run `mise run build` and `mise run package` when implementation, Alfred workflow definitions, build scripts, or packaging behavior changes.
- For documentation-only changes, verify language, links, and `git diff --check`; a package rebuild is not required.
