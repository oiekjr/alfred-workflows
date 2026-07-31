# GitHub Navigator

Use GitHub Navigator to find repositories and Projects available to the active GitHub CLI account from Alfred. You can also open your personal GitHub Issues and Pull requests pages.

## Check the requirements

Before installing GitHub Navigator, make sure you have:

- macOS 13 or later
- Alfred 5
- Alfred Powerpack
- [GitHub CLI](https://cli.github.com/) 2.60.0 or later

Install GitHub CLI in a standard Homebrew or MacPorts location. The fixed Issues and Pull requests links work even when GitHub CLI is missing or not authenticated.

## Install the workflow

1. Open the repository's [GitHub Releases](https://github.com/oiekjr/alfred-workflows/releases).
2. Download `github-repositories-<version>.alfredworkflow`.
3. Double-click the downloaded file.
4. Review and confirm the import in Alfred.

## Authenticate with GitHub

Repository search uses the active GitHub.com account configured by GitHub CLI.

1. Type `gh` in Alfred.
2. If Alfred displays `Sign in to GitHub`, select it.
3. Complete GitHub CLI's web authentication flow in Terminal.
4. Return to Alfred and retry the same input.

The workflow does not copy an authentication code to the clipboard or generate or upload an SSH key.

GitHub Projects require the `read:project` OAuth scope:

- If you are signed out, select `Sign in to GitHub for Projects` to start web authentication with read-only Projects access.
- If you are already signed in without the required scope, select `Authorize GitHub Projects` to add only `read:project` to the existing authentication.

The workflow does not request the `project` write scope. Depending on the Organization's policy, you may also need to approve the GitHub CLI OAuth App or authorize it for SAML SSO.

Authentication provided only through environment variables is not supported. A custom `GH_CONFIG_DIR` is also unsupported; use the standard `gh auth login` configuration.

## Find a repository

1. Type `gh` to list repositories visible to the active account.
2. Add one or more characters to filter by owner or repository name.
3. Select a result to open its GitHub page in the default browser.

Matching is case-insensitive and checks every position in the full `owner/repository` name. Filtering starts with the first character. The initial `gh` request starts immediately, while subsequent input is applied 300 milliseconds after the last character.

Repository results include repositories that:

- You own
- You can access as a collaborator
- You can access through Organization membership

The workflow does not search every public repository on GitHub or use your starred repositories as a separate result source.

## Open Issues or Pull requests

Use an exact command to open GitHub's personal activity page:

| Input | Destination |
| --- | --- |
| `gh issue` or `gh issues` | [GitHub Issues](https://github.com/issues) |
| `gh pr` or `gh prs` | [GitHub Pull requests](https://github.com/pulls) |

These exact commands do not launch GitHub CLI or call an API. Inputs such as `gh issue example` continue through repository search instead of opening the fixed page.

## Find a Project

1. Type `gh project` or `gh projects` to list accessible open Projects.
2. Add one or more characters to filter by owner or Project title.
3. Select a result to open its GitHub Project page.

Examples:

```text
gh project roadmap
gh projects example-org
```

Project results include open Projects owned by you or by an Organization you belong to when the active account has at least read access. Each owner is limited to 100 Projects. Closed Projects are excluded.

Organization Projects use the Organization avatar, and personal Projects use the user avatar.

## Troubleshoot the workflow

If the workflow reports that GitHub CLI is missing or outdated:

1. Install GitHub CLI 2.60.0 or later with Homebrew or MacPorts.
2. Confirm that it is in the standard installation location.
3. Retry the Alfred input.

If repository search asks you to sign in, complete the `Sign in to GitHub` action. If Project search asks for additional access, use the Project-specific sign-in or authorization action.

If you run `gh auth logout` or `gh auth switch` outside the workflow, results from the previous active account can remain visible for up to 60 seconds. Retry after the short-lived list cache expires.

Missing or unavailable avatars do not prevent repository or Project results from appearing.

## Review data handling

After authentication succeeds, the workflow retrieves repository and Project lists with `gh api`. It validates and normalizes the minimum required fields, then stores them in Alfred's private workflow cache for 60 seconds. Expired cache files are removed the next time they are read. Authentication actions and invalid cache formats also invalidate the list cache.

While the list cache is valid, the workflow does not launch `gh`; it filters the cached data locally in Go. The search text entered in Alfred is not stored in the cache.

Projects are retrieved with a fixed GraphQL query. Search text is never added to that query and is matched locally after retrieval.

Access tokens, search text, GitHub API error details, and GitHub CLI standard error output are neither cached nor displayed in Alfred.

Repository and Project destination URLs are validated before they become selectable. Only the expected GitHub.com repository and Project URL forms are accepted.

The workflow validates the GitHub CLI installation and copies the trusted executable into Alfred's private cache before use. GitHub CLI runs with a restricted environment that does not inherit parent-process tokens, proxy settings, browser settings, or `PATH`.

Owner avatars are refreshed in a background process so image downloads do not delay search results. Images are downloaded directly from approved GitHub HTTPS hosts, stored with private permissions, and refreshed after seven days. Search text and API responses are not passed as background-process arguments.

See the repository-wide [security policy](../../SECURITY.md) for trust boundaries and vulnerability reporting.

## Develop and package the workflow

Run validation, Universal Binary builds, and packaging from the repository root:

```sh
mise run check
mise run build
mise run package
```

The tasks write:

```text
build/github-repositories
dist/github-repositories-<version>.alfredworkflow
dist/github-repositories-<version>.alfredworkflow.sha256
```

The artifact name remains `github-repositories` for compatibility, even though the Alfred display name is GitHub Navigator.

Builds disable network access and ignore the parent process's language settings. Packaging validates the ZIP contents, binary architectures, ad hoc code signature, and SHA-256 checksum.
