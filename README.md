# Alfred Workflows

Use this repository to install, build, and maintain independent workflows for [Alfred 5](https://www.alfredapp.com/).

## Choose a workflow

| Workflow | Keyword | What it does |
| --- | --- | --- |
| [GitHub Navigator](workflows/github-repositories/README.md) | `gh` | Finds accessible GitHub repositories and Projects, and opens personal Issues and Pull requests pages |

Open the workflow-specific README for its usage, authentication, and additional requirements.

## Install a workflow

Before installing a workflow, make sure you have:

- macOS 13 or later
- Alfred 5
- Alfred Powerpack

Then install the workflow:

1. Open the repository's [GitHub Releases](https://github.com/oiekjr/alfred-workflows/releases).
2. Download the `.alfredworkflow` file for the workflow you want.
3. Double-click the downloaded file.
4. Review and confirm the import in Alfred.
5. Follow the workflow-specific README to complete any authentication or tool setup.

Each workflow is distributed as an independent artifact.

## Set up the development environment

Language and tool versions are managed with [mise](https://mise.jdx.dev/).

1. Install mise.
2. From the repository root, install the pinned tools:

   ```sh
   mise install
   ```

3. Put developer-specific overrides in `mise.local.toml`. This file is excluded from Git.

The current repository uses Go to build self-contained executables, so workflow users do not need Go or mise.

## Validate changes

Run all formatting, static analysis, and unit-test checks from the repository root:

```sh
mise run check
```

## Build a workflow

Build the current workflow executable as a macOS Universal Binary:

```sh
mise run build
```

The current build task writes:

```text
build/github-repositories
```

## Package a workflow

Create an installable Alfred artifact and its checksum:

```sh
mise run package
```

The current package task writes:

```text
dist/github-repositories-<version>.alfredworkflow
dist/github-repositories-<version>.alfredworkflow.sha256
```

The package task validates the workflow property list, binary architectures, ad hoc code signature, ZIP contents, and SHA-256 checksum.

## Add or maintain a workflow

When adding or changing a workflow:

1. Give it a short, stable identifier.
2. Keep its executable entry point under `cmd/`, internal implementation under `internal/`, Alfred definition under `workflows/`, and development automation under `scripts/`.
3. Keep each workflow's definition, implementation, documentation, version, and artifact independent from other workflows.
4. Document workflow-specific requirements and constraints in that workflow's README.
5. Pin any approved language or toolchain version with mise.
6. Do not commit Alfred's personal `prefs.plist`, API keys or other secrets, or user-specific absolute paths.

## Prepare a release

Version and publish each workflow independently, and attach its `.alfredworkflow` artifact to GitHub Releases.

Executables intended for workflow users must be Universal Binaries and must not require a language runtime or mise on the user's Mac.

The generated SHA-256 checksum and ad hoc code signature help detect corruption or unintended replacement, but they do not authenticate the publisher. Configure authenticated signing or equivalent signed provenance before relying on the release channel for publisher identity.

## Report a security issue

Read [SECURITY.md](SECURITY.md) before reporting a vulnerability. Do not put credentials, private repository details, or exploit secrets in a public issue.

## License

[MIT License](LICENSE)
