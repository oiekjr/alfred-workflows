// Package githubrepos は GitHub上の対象をAlfred向け候補へ変換する。
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
	"unicode"
)

const (
	githubHostname             = "github.com"
	githubCLIWebsite           = "https://cli.github.com/"
	githubIssuesURL            = "https://github.com/issues"
	githubPullRequestsURL      = "https://github.com/pulls"
	minimumGitHubCLI           = "2.60.0"
	versionTimeout             = 5 * time.Second
	authenticationTimeout      = 5 * time.Second
	apiTimeout                 = 30 * time.Second
	shortOutputLimit           = 4 * 1024
	apiOutputLimit             = 16 * 1024 * 1024
	stderrLimit                = 8 * 1024
	repositoryDescriptionLimit = 4 * 1024
)

var minimumVersion = version{major: 2, minor: 60, patch: 0}

type inputMode int

const (
	repositoryInput inputMode = iota
	issuesInput
	pullRequestsInput
	projectsInput
)

type routedInput struct {
	mode  inputMode
	query string
}

// Feed は Alfred Script Filter へ渡す応答を表現する。
type Feed struct {
	Items []Item `json:"items"`

	avatarRefreshNeeded bool
}

// NeedsAvatarRefresh は不足または期限切れのアバターがあるか返す。
func (feed Feed) NeedsAvatarRefresh() bool {
	return feed.avatarRefreshNeeded
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
	runner       CommandRunner
	avatars      avatarProvider
	lists        listCacheProvider
	githubConfig githubConfigProvider
}

// NewApp は GitHub上の対象を列挙するアプリケーションを初期化する。
func NewApp(runner CommandRunner) App {
	return App{
		runner:       runner,
		avatars:      newEnvironmentAvatarCache(),
		lists:        newEnvironmentListCache(),
		githubConfig: environmentGitHubConfigProvider{},
	}
}

// Run は入力と現在のGitHub CLI の状態に対応するAlfred向け応答を生成する。
func (app App) Run(ctx context.Context, query string) Feed {
	input := routeInput(query)
	switch input.mode {
	case issuesInput:
		return fixedLinkFeed(
			"GitHub Issues",
			"Open your GitHub issues in the default browser.",
			githubIssuesURL,
		)
	case pullRequestsInput:
		return fixedLinkFeed(
			"GitHub Pull requests",
			"Open your GitHub pull requests in the default browser.",
			githubPullRequestsURL,
		)
	}

	configIdentity, configAvailable := app.currentGitHubConfigIdentity()
	if app.lists != nil && !configAvailable {
		_ = app.lists.Invalidate()
	}
	if input.mode == projectsInput {
		if app.lists != nil && configAvailable {
			if projects, ok := app.lists.LoadProjects(configIdentity); ok {
				if app.githubConfigStillCurrent(configIdentity) {
					return app.projectFeed(projects, input.query, true)
				}
				_ = app.lists.Invalidate()
				configIdentity, configAvailable = app.currentGitHubConfigIdentity()
			}
		}
	} else if app.lists != nil && configAvailable {
		if repositories, ok := app.lists.LoadRepositories(configIdentity); ok {
			if app.githubConfigStillCurrent(configIdentity) {
				return app.repositoryFeed(repositories, input.query, true)
			}
			_ = app.lists.Invalidate()
			configIdentity, configAvailable = app.currentGitHubConfigIdentity()
		}
	}

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
		Path: githubCLIPath,
		Args: []string{
			"auth", "status",
			"--active",
			"--hostname", githubHostname,
		},
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
		if input.mode == projectsInput {
			return projectLoginFeed(loginHelperToken())
		}

		return loginFeed(loginHelperToken())
	}

	authentication, ok := parseAuthenticationStatus(authenticationResult.Stdout)
	if !ok {
		return failureFeed(
			"Unable to check GitHub authentication",
			"GitHub CLI returned an invalid authentication response.",
		)
	}

	cacheAccount := app.stableCacheAccount(
		authentication,
		configIdentity,
		configAvailable,
	)
	if input.mode == projectsInput {
		if !hasProjectReadScope(authentication.Scopes) {
			return projectAuthorizationFeed(loginHelperToken())
		}

		return app.runProjects(ctx, githubCLIPath, input.query, cacheAccount)
	}

	return app.runRepositories(ctx, githubCLIPath, input.query, cacheAccount)
}

// currentGitHubConfigIdentity は一覧キャッシュ照合用のGitHub CLI設定情報を取得する。
func (app App) currentGitHubConfigIdentity() (githubConfigIdentity, bool) {
	if app.githubConfig == nil {
		return githubConfigIdentity{}, false
	}

	return app.githubConfig.CurrentIdentity()
}

// githubConfigStillCurrent は取得済みGitHub CLI設定情報が現在も一致するか確認する。
func (app App) githubConfigStillCurrent(config githubConfigIdentity) bool {
	if !config.valid() {
		return false
	}
	currentConfig, ok := app.currentGitHubConfigIdentity()

	return ok && currentConfig == config
}

// stableCacheAccount は認証確認中に設定が変わっていないアカウントを返す。
func (app App) stableCacheAccount(
	authentication authenticationStatus,
	initialConfig githubConfigIdentity,
	initialConfigAvailable bool,
) *githubAccountIdentity {
	if !initialConfigAvailable {
		return nil
	}
	if !app.githubConfigStillCurrent(initialConfig) {
		return nil
	}

	account := githubAccountIdentity{
		Hostname: authentication.Hostname,
		Login:    authentication.Login,
		Config:   initialConfig,
	}
	if !account.valid() {
		return nil
	}

	return &account
}

// cacheAccountStillCurrent はAPI取得中に認証主体の設定が変わっていないか確認する。
func (app App) cacheAccountStillCurrent(account *githubAccountIdentity) bool {
	if account == nil || !account.valid() {
		return false
	}

	return app.githubConfigStillCurrent(account.Config)
}

// loginHelperToken は認証導線が必要になった時だけ実行ファイルを検証する。
func loginHelperToken() string {
	token, _ := currentLoginHelperToken()
	return token
}

// runRepositories は閲覧可能なリポジトリを取得してAlfred向け応答を生成する。
func (app App) runRepositories(
	ctx context.Context,
	githubCLIPath string,
	query string,
	cacheAccount *githubAccountIdentity,
) Feed {
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

	normalizedRepositories, validRepositoryCount := normalizeRepositories(repositories)
	if len(repositories) > 0 && validRepositoryCount == 0 {
		return repositoryFailureFeed(false)
	}
	cacheAvailable := false
	if app.lists != nil && app.cacheAccountStillCurrent(cacheAccount) {
		cacheAvailable = app.lists.StoreRepositories(
			*cacheAccount,
			normalizedRepositories,
		) == nil
	}

	return app.repositoryFeed(normalizedRepositories, query, cacheAvailable)
}

// repositoryFeed は検証済みリポジトリを検索し、Alfred向け応答を生成する。
func (app App) repositoryFeed(
	repositories []repository,
	query string,
	cacheAvailable bool,
) Feed {
	if len(repositories) == 0 {
		return emptyFeed()
	}

	matchingRepositories := filterRepositories(repositories, query)
	if len(matchingRepositories) == 0 {
		return noMatchFeed()
	}

	avatarPaths := make(map[int64]string)
	avatarRefreshNeeded := false
	if app.avatars != nil {
		avatarResult := app.avatars.Paths(repositoryOwners(matchingRepositories))
		avatarPaths = avatarResult.Paths
		avatarRefreshNeeded = avatarResult.RefreshNeeded
	}

	items := repositoryItems(matchingRepositories, avatarPaths)

	return Feed{
		Items:               items,
		avatarRefreshNeeded: cacheAvailable && avatarRefreshNeeded,
	}
}

// routeInput は利用者入力を固定リンク、Project検索、リポジトリ検索へ分類する。
func routeInput(query string) routedInput {
	normalizedQuery := strings.TrimSpace(query)
	switch {
	case strings.EqualFold(normalizedQuery, "issue"),
		strings.EqualFold(normalizedQuery, "issues"):
		return routedInput{mode: issuesInput}
	case strings.EqualFold(normalizedQuery, "pr"),
		strings.EqualFold(normalizedQuery, "prs"):
		return routedInput{mode: pullRequestsInput}
	}

	commandEnd := strings.IndexFunc(normalizedQuery, unicode.IsSpace)
	command := normalizedQuery
	projectQuery := ""
	if commandEnd >= 0 {
		command = normalizedQuery[:commandEnd]
		projectQuery = strings.TrimSpace(normalizedQuery[commandEnd:])
	}
	if strings.EqualFold(command, "project") || strings.EqualFold(command, "projects") {
		return routedInput{
			mode:  projectsInput,
			query: projectQuery,
		}
	}

	return routedInput{
		mode:  repositoryInput,
		query: query,
	}
}

// fixedLinkFeed はGitHub上の固定ページを開く候補を生成する。
func fixedLinkFeed(title string, subtitle string, targetURL string) Feed {
	return Feed{Items: []Item{{
		Title:        title,
		Subtitle:     subtitle,
		Arg:          targetURL,
		QuickLookURL: targetURL,
		Valid:        true,
		Variables:    map[string]string{"action": "open"},
	}}}
}

// hasProjectReadScope はGitHub CLI認証にProject読取権限があるか判定する。
func hasProjectReadScope(scopes string) bool {
	for _, value := range strings.Split(scopes, ",") {
		scope := strings.Trim(strings.TrimSpace(value), "'\"")
		if scope == projectReadScope || scope == projectWriteScope {
			return true
		}
	}

	return false
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

// normalizeRepositories はリポジトリを検証・正規化して安定順へ並べる。
func normalizeRepositories(repositories []repository) ([]repository, int) {
	normalizedRepositories := make([]repository, 0, len(repositories))
	for _, value := range repositories {
		if value.ID <= 0 ||
			value.FullName == "" ||
			!isGitHubRepositoryURL(value.HTMLURL, value.FullName) {
			continue
		}

		if value.Description != nil {
			description := boundedDisplayText(*value.Description, repositoryDescriptionLimit)
			value.Description = &description
		}
		normalizedRepositories = append(normalizedRepositories, value)
	}

	sort.SliceStable(normalizedRepositories, func(leftIndex, rightIndex int) bool {
		left := strings.ToLower(normalizedRepositories[leftIndex].FullName)
		right := strings.ToLower(normalizedRepositories[rightIndex].FullName)
		if left == right {
			return normalizedRepositories[leftIndex].FullName <
				normalizedRepositories[rightIndex].FullName
		}

		return left < right
	})

	return normalizedRepositories, len(normalizedRepositories)
}

// filterRepositories は検証済みリポジトリから検索語を含む項目を抽出する。
func filterRepositories(repositories []repository, query string) []repository {
	normalizedQuery := normalizedFilterQuery(query)
	matches := make([]repository, 0, len(repositories))
	for _, value := range repositories {
		if normalizedQuery != "" && !strings.Contains(strings.ToLower(value.FullName), normalizedQuery) {
			continue
		}

		matches = append(matches, value)
	}

	return matches
}

// normalizedFilterQuery は検索語の前後空白と大文字小文字を正規化する。
func normalizedFilterQuery(query string) string {
	return strings.ToLower(strings.TrimSpace(query))
}

// repositoryOwners はリポジトリから所有者情報を抽出する。
func repositoryOwners(repositories []repository) []githubOwner {
	owners := make([]githubOwner, 0, len(repositories))
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
	ID          int64       `json:"id"`
	FullName    string      `json:"full_name"`
	HTMLURL     string      `json:"html_url"`
	Private     bool        `json:"private"`
	Description *string     `json:"description"`
	Archived    bool        `json:"archived"`
	Fork        bool        `json:"fork"`
	Owner       githubOwner `json:"owner"`
}

type githubOwner struct {
	ID        int64  `json:"id,omitempty"`
	NodeID    string `json:"node_id,omitempty"`
	Login     string `json:"login"`
	AvatarURL string `json:"avatar_url"`
	Type      string `json:"type"`
}
