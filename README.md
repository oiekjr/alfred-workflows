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

The current repository uses Node.js source modules without npm dependencies. Workflow users need Node.js 22 or later, but they do not need mise or repository development tools.

## Validate changes

Run all formatting, static analysis, and unit-test checks from the repository root:

```sh
mise run check
```

GitHub Actions runs the same task for pull requests and pushes to `main`.

## Build a workflow

Build the validated source distribution tree:

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

The package task validates the workflow property list, source file permissions, absence of bundled Mach-O executables, ZIP contents, and SHA-256 checksum.

## Add or maintain a workflow

When adding or changing a workflow:

1. Give it a short, stable identifier.
2. Keep its Alfred definition, launcher, and runtime source under its own `workflows/` directory, and keep shared development automation under `scripts/`.
3. Keep each workflow's definition, implementation, documentation, version, and artifact independent from other workflows.
4. Document workflow-specific requirements and constraints in that workflow's README.
5. Pin any approved language or toolchain version with mise.
6. Do not commit Alfred's personal `prefs.plist`, API keys or other secrets, or user-specific absolute paths.

## Publish GitHub Navigator

Version and publish each workflow independently. The release workflow publishes GitHub Navigator when a release-ready change reaches `main` with a version that has not been published.

1. Update `version` in `workflows/github-repositories/info.plist`.
2. Validate and package the workflow locally:

   ```sh
   mise run check
   mise run package
   ```

3. Commit the release-ready changes and merge them into `main`.

A push to `main` starts the release workflow. If `github-repositories-v<version>` is already published, the workflow exits without publishing another release. Otherwise, a successful run creates that tag and immediately publishes a GitHub Release containing the `.alfredworkflow` artifact and its SHA-256 checksum, and associates a GitHub artifact attestation with the packaged workflow.

The workflow rejects versions that do not use `MAJOR.MINOR.PATCH`, existing draft releases, and an unpublished matching tag that points to another commit. GitHub Navigator is distributed as interpreted source rather than a bundled native executable; users need Node.js 22 or later but do not need mise.

## Report a security issue

Read [SECURITY.md](SECURITY.md) before reporting a vulnerability. Do not put credentials, private repository details, or exploit secrets in a public issue.

## License

[MIT License](LICENSE)
