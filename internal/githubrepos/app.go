// Package githubrepos は GitHub CLI から取得したリポジトリをAlfred向けに変換する。
package githubrepos

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"
)

const (
	githubHostname        = "github.com"
	githubCLIWebsite      = "https://cli.github.com/"
	minimumGitHubCLI      = "2.60.0"
	versionTimeout        = 5 * time.Second
	authenticationTimeout = 5 * time.Second
	apiTimeout            = 30 * time.Second
	shortOutputLimit      = 4 * 1024
	apiOutputLimit        = 16 * 1024 * 1024
	stderrLimit           = 8 * 1024
)

var minimumVersion = version{major: 2, minor: 60, patch: 0}

// Feed は Alfred Script Filter へ渡す応答を表現する。
type Feed struct {
	Items []Item `json:"items"`
}

// Item は Alfred に表示する1件の候補を表現する。
type Item struct {
	UID          string            `json:"uid,omitempty"`
	Title        string            `json:"title"`
	Subtitle     string            `json:"subtitle,omitempty"`
	Arg          string            `json:"arg,omitempty"`
	Match        string            `json:"match,omitempty"`
	QuickLookURL string            `json:"quicklookurl,omitempty"`
	Icon         *Icon             `json:"icon,omitempty"`
	Valid        bool              `json:"valid"`
	Variables    map[string]string `json:"variables,omitempty"`
}

// Icon は Alfred に表示する画像パスを表現する。
type Icon struct {
	Path string `json:"path"`
}

// App は GitHub CLI との連携処理を提供する。
type App struct {
	runner           CommandRunner
	avatars          avatarProvider
	loginHelperToken string
}

// NewApp は GitHubリポジトリを列挙するアプリケーションを初期化する。
func NewApp(runner CommandRunner) App {
	loginHelperToken, _ := currentLoginHelperToken()

	return App{
		runner:           runner,
		avatars:          newEnvironmentAvatarCache(),
		loginHelperToken: loginHelperToken,
	}
}

// Run は検索語と現在のGitHub CLI の状態に対応するAlfred向け応答を生成する。
func (app App) Run(ctx context.Context, query string) Feed {
	githubCLIPath, err := app.runner.FindExecutable("gh")
	if err != nil {
		return installFeed("Install GitHub CLI")
	}

	versionResult := app.runner.Run(ctx, Command{
		Path:        githubCLIPath,
		Args:        []string{"--version"},
		Timeout:     versionTimeout,
		StdoutLimit: shortOutputLimit,
		StderrLimit: stderrLimit,
	})
	if commandFailed(versionResult) {
		return failureFeed(
			"Unable to run GitHub CLI",
			"Check your GitHub CLI installation, then try again.",
		)
	}

	currentVersion, ok := parseGitHubCLIVersion(versionResult.Stdout)
	if !ok {
		return failureFeed(
			"Unable to check GitHub CLI",
			"Install GitHub CLI 2.60.0 or later, then try again.",
		)
	}
	if currentVersion.lessThan(minimumVersion) {
		return installFeed("Update GitHub CLI")
	}

	authenticationResult := app.runner.Run(ctx, Command{
		Path:        githubCLIPath,
		Args:        []string{"auth", "status", "--active", "--hostname", githubHostname},
		Timeout:     authenticationTimeout,
		StdoutLimit: shortOutputLimit,
		StderrLimit: stderrLimit,
	})
	if authenticationResult.TimedOut {
		return failureFeed(
			"Unable to check GitHub authentication",
			"GitHub CLI did not respond in time. Try again.",
		)
	}
	if authenticationResult.StdoutOverflow || authenticationResult.StderrOverflow {
		return failureFeed(
			"Unable to check GitHub authentication",
			"GitHub CLI returned an unexpectedly large response.",
		)
	}
	if authenticationResult.Err != nil {
		return loginFeed(app.loginHelperToken)
	}

	repositoriesResult := app.runner.Run(ctx, Command{
		Path: githubCLIPath,
		Args: []string{
			"api", "/user/repos",
			"--hostname", githubHostname,
			"--method", "GET",
			"--paginate",
			"-F", "per_page=100",
			"-f", "visibility=all",
			"-f", "affiliation=owner,collaborator,organization_member",
			"-f", "sort=full_name",
			"-f", "direction=asc",
			"--jq", ".[] | {id, full_name, html_url, private, description, archived, fork, owner: (.owner | {id, login, avatar_url, type})}",
		},
		Timeout:     apiTimeout,
		StdoutLimit: apiOutputLimit,
		StderrLimit: stderrLimit,
	})
	if commandFailed(repositoriesResult) {
		return repositoryFailureFeed(repositoriesResult.TimedOut)
	}

	repositories, err := parseRepositories(repositoriesResult.Stdout)
	if err != nil {
		return repositoryFailureFeed(false)
	}
	if len(repositories) == 0 {
		return emptyFeed()
	}

	matchingRepositories, validRepositoryCount := filterRepositories(repositories, query)
	if validRepositoryCount == 0 {
		return repositoryFailureFeed(false)
	}
	if len(matchingRepositories) == 0 {
		return noMatchFeed()
	}

	avatarPaths := make(map[int64]string)
	if app.avatars != nil {
		avatarPaths = app.avatars.Paths(ctx, repositoryOwners(matchingRepositories))
	}

	items := repositoryItems(matchingRepositories, avatarPaths)

	return Feed{Items: items}
}

// commandFailed はコマンド結果を利用できない状態か判定する。
func commandFailed(result CommandResult) bool {
	return result.Err != nil ||
		result.TimedOut ||
		result.StdoutOverflow ||
		result.StderrOverflow
}

// parseGitHubCLIVersion は GitHub CLI のバージョン出力を解析する。
func parseGitHubCLIVersion(output []byte) (version, bool) {
	fields := strings.Fields(string(output))
	for index, field := range fields {
		if field == "version" && index+1 < len(fields) {
			return parseVersion(fields[index+1])
		}
	}

	return version{}, false
}

// parseVersion はドット区切りのバージョン番号を解析する。
func parseVersion(value string) (version, bool) {
	value = strings.TrimPrefix(value, "v")
	value = strings.SplitN(value, "-", 2)[0]
	parts := strings.Split(value, ".")
	if len(parts) != 3 {
		return version{}, false
	}

	numbers := make([]int, len(parts))
	for index, part := range parts {
		number, err := strconv.Atoi(part)
		if err != nil || number < 0 {
			return version{}, false
		}
		numbers[index] = number
	}

	return version{major: numbers[0], minor: numbers[1], patch: numbers[2]}, true
}

// lessThan はバージョンが比較対象より古いか判定する。
func (current version) lessThan(other version) bool {
	if current.major != other.major {
		return current.major < other.major
	}
	if current.minor != other.minor {
		return current.minor < other.minor
	}

	return current.patch < other.patch
}

// parseRepositories は改行区切りのGitHub API応答を解析する。
func parseRepositories(output []byte) ([]repository, error) {
	decoder := json.NewDecoder(bytes.NewReader(output))
	repositories := make([]repository, 0)

	for {
		var value repository
		err := decoder.Decode(&value)
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("decode repository: %w", err)
		}

		repositories = append(repositories, value)
	}

	return repositories, nil
}

// filterRepositories は安全性を検証し、検索語を含むリポジトリを抽出する。
func filterRepositories(repositories []repository, query string) ([]repository, int) {
	sort.SliceStable(repositories, func(leftIndex, rightIndex int) bool {
		left := strings.ToLower(repositories[leftIndex].FullName)
		right := strings.ToLower(repositories[rightIndex].FullName)
		if left == right {
			return repositories[leftIndex].FullName < repositories[rightIndex].FullName
		}

		return left < right
	})

	normalizedQuery := strings.ToLower(strings.TrimSpace(query))
	matches := make([]repository, 0, len(repositories))
	validRepositoryCount := 0
	for _, value := range repositories {
		if value.ID <= 0 || value.FullName == "" || !isGitHubRepositoryURL(value.HTMLURL, value.FullName) {
			continue
		}
		validRepositoryCount++
		if normalizedQuery != "" && !strings.Contains(strings.ToLower(value.FullName), normalizedQuery) {
			continue
		}

		matches = append(matches, value)
	}

	return matches, validRepositoryCount
}

// repositoryOwners はリポジトリから所有者情報を抽出する。
func repositoryOwners(repositories []repository) []repositoryOwner {
	owners := make([]repositoryOwner, 0, len(repositories))
	for _, value := range repositories {
		owners = append(owners, value.Owner)
	}

	return owners
}

// repositoryItems はリポジトリをAlfred候補へ変換する。
func repositoryItems(repositories []repository, avatarPaths map[int64]string) []Item {
	items := make([]Item, 0, len(repositories))
	for _, value := range repositories {
		item := Item{
			UID:          strconv.FormatInt(value.ID, 10),
			Title:        value.FullName,
			Subtitle:     repositorySubtitle(value),
			Arg:          value.HTMLURL,
			Match:        value.FullName,
			QuickLookURL: value.HTMLURL,
			Valid:        true,
			Variables:    map[string]string{"action": "open"},
		}
		if avatarPath := avatarPaths[value.Owner.ID]; avatarPath != "" {
			item.Icon = &Icon{Path: avatarPath}
		}

		items = append(items, item)
	}

	return items
}

// repositorySubtitle は公開状態と補足情報を読みやすく連結する。
func repositorySubtitle(value repository) string {
	labels := make([]string, 0, 3)
	if value.Private {
		labels = append(labels, "Private")
	} else {
		labels = append(labels, "Public")
	}
	if value.Archived {
		labels = append(labels, "Archived")
	}
	if value.Fork {
		labels = append(labels, "Fork")
	}

	subtitle := strings.Join(labels, " · ")
	if value.Description == nil {
		return subtitle
	}

	description := strings.Join(strings.Fields(*value.Description), " ")
	if description == "" {
		return subtitle
	}

	return subtitle + " — " + description
}

// isGitHubRepositoryURL は GitHub.com 上の対象リポジトリURLだけを許可する。
func isGitHubRepositoryURL(rawURL string, fullName string) bool {
	parsedURL, err := url.Parse(rawURL)
	if err != nil {
		return false
	}

	return parsedURL.Scheme == "https" &&
		parsedURL.Host == githubHostname &&
		parsedURL.User == nil &&
		parsedURL.RawQuery == "" &&
		parsedURL.Fragment == "" &&
		parsedURL.Path == "/"+fullName
}

// installFeed は GitHub CLI の導入ページを開く候補を生成する。
func installFeed(title string) Feed {
	return Feed{Items: []Item{{
		Title:        title,
		Subtitle:     "GitHub CLI " + minimumGitHubCLI + " or later is required.",
		Arg:          githubCLIWebsite,
		QuickLookURL: githubCLIWebsite,
		Valid:        true,
		Variables:    map[string]string{"action": "open"},
	}}}
}

// loginFeed は GitHub CLI のWeb認証を開始する候補を生成する。
func loginFeed(helperToken string) Feed {
	if helperToken == "" {
		return failureFeed(
			"Unable to start GitHub authentication",
			"Reinstall the workflow, then try again.",
		)
	}

	return Feed{Items: []Item{{
		Title:    "Sign in to GitHub",
		Subtitle: "Press Return to authenticate with GitHub CLI.",
		Valid:    true,
		Variables: map[string]string{
			"action":       "login",
			"login_helper": helperToken,
		},
	}}}
}

// emptyFeed は閲覧可能なリポジトリがない状態を通知する。
func emptyFeed() Feed {
	return failureFeed(
		"No repositories found",
		"The active GitHub account has no accessible repositories.",
	)
}

// noMatchFeed は検索語に一致するリポジトリがない状態を通知する。
func noMatchFeed() Feed {
	return failureFeed(
		"No matching repositories",
		"No repository owner or name contains your query.",
	)
}

// repositoryFailureFeed はリポジトリ一覧を取得できない状態を通知する。
func repositoryFailureFeed(timedOut bool) Feed {
	if timedOut {
		return failureFeed(
			"Unable to load repositories",
			"GitHub did not respond in time. Try again.",
		)
	}

	return failureFeed(
		"Unable to load repositories",
		"Check your connection and GitHub CLI authentication, then try again.",
	)
}

// failureFeed は選択できないエラー候補を生成する。
func failureFeed(title string, subtitle string) Feed {
	return Feed{Items: []Item{{
		Title:    title,
		Subtitle: subtitle,
		Valid:    false,
	}}}
}

type version struct {
	major int
	minor int
	patch int
}

type repository struct {
	ID          int64           `json:"id"`
	FullName    string          `json:"full_name"`
	HTMLURL     string          `json:"html_url"`
	Private     bool            `json:"private"`
	Description *string         `json:"description"`
	Archived    bool            `json:"archived"`
	Fork        bool            `json:"fork"`
	Owner       repositoryOwner `json:"owner"`
}

type repositoryOwner struct {
	ID        int64  `json:"id"`
	Login     string `json:"login"`
	AvatarURL string `json:"avatar_url"`
	Type      string `json:"type"`
}
