package githubrepos

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

// TestAppRunShowsInstallItemWhenGitHubCLIIsMissingは未導入時の案内を検証する。
func TestAppRunShowsInstallItemWhenGitHubCLIIsMissing(t *testing.T) {
	runner := &fakeRunner{findErr: errors.New("not found")}
	app := NewApp(runner)

	feed := app.Run(context.Background(), "")

	assertSingleItem(t, feed, "Install GitHub CLI", true, "open")
}

// TestAppRunShowsUpdateItemForOldGitHubCLIは最低バージョン未満の案内を検証する。
func TestAppRunShowsUpdateItemForOldGitHubCLI(t *testing.T) {
	runner := &fakeRunner{
		executablePath: "/usr/local/bin/gh",
		results: []CommandResult{
			{Stdout: []byte("gh version 2.59.0 (2024-11-06)\n")},
		},
	}
	app := NewApp(runner)

	feed := app.Run(context.Background(), "")

	assertSingleItem(t, feed, "Update GitHub CLI", true, "open")
}

// TestAppRunOpensFixedLinksWithoutGitHubCLI は固定リンクがGitHub CLIへ依存しないことを検証する。
func TestAppRunOpensFixedLinksWithoutGitHubCLI(t *testing.T) {
	testCases := []struct {
		name      string
		query     string
		wantTitle string
		wantURL   string
	}{
		{
			name:      "issues singular",
			query:     " issue ",
			wantTitle: "GitHub Issues",
			wantURL:   "https://github.com/issues",
		},
		{
			name:      "issues plural",
			query:     "ISSUES",
			wantTitle: "GitHub Issues",
			wantURL:   "https://github.com/issues",
		},
		{
			name:      "pull requests singular",
			query:     "Pr",
			wantTitle: "GitHub Pull requests",
			wantURL:   "https://github.com/pulls",
		},
		{
			name:      "pull requests plural",
			query:     "prs",
			wantTitle: "GitHub Pull requests",
			wantURL:   "https://github.com/pulls",
		},
	}

	for _, testCase := range testCases {
		t.Run(testCase.name, func(t *testing.T) {
			runner := &fakeRunner{findErr: errors.New("GitHub CLI must not be resolved")}
			app := NewApp(runner)

			feed := app.Run(context.Background(), testCase.query)

			assertSingleItem(t, feed, testCase.wantTitle, true, "open")
			item := feed.Items[0]
			if item.Arg != testCase.wantURL || item.QuickLookURL != testCase.wantURL {
				t.Fatalf("fixed URL item = %#v", item)
			}
			if runner.findCalls != 0 || len(runner.commands) != 0 {
				t.Fatalf("GitHub CLI calls = find %d, commands %d", runner.findCalls, len(runner.commands))
			}
		})
	}
}

// TestAppRunUsesRepositoryCacheWithoutGitHubCLI は追加入力がローカル検索だけで完了することを検証する。
func TestAppRunUsesRepositoryCacheWithoutGitHubCLI(t *testing.T) {
	cache := newListCache(secureTempDirectory(t), time.Now)
	if err := cache.StoreRepositories([]repository{
		{
			ID:       1,
			FullName: "owner/alpha-repository",
			HTMLURL:  "https://github.com/owner/alpha-repository",
		},
		{
			ID:       2,
			FullName: "owner/other",
			HTMLURL:  "https://github.com/owner/other",
		},
	}); err != nil {
		t.Fatalf("store repository cache: %v", err)
	}
	runner := &fakeRunner{findErr: errors.New("GitHub CLI must not be resolved")}
	app := NewApp(runner)
	app.lists = cache
	app.avatars = nil

	feed := app.Run(context.Background(), "PHA-REPO")

	if len(feed.Items) != 1 || feed.Items[0].Title != "owner/alpha-repository" {
		t.Fatalf("cached items = %#v", feed.Items)
	}
	if runner.findCalls != 0 || len(runner.commands) != 0 {
		t.Fatalf("GitHub CLI calls = find %d, commands %d", runner.findCalls, len(runner.commands))
	}
}

// TestAppRunFetchesRepositoriesBeforeLocalFiltering は空入力で取得し1文字からローカル絞り込みすることを検証する。
func TestAppRunFetchesRepositoriesBeforeLocalFiltering(t *testing.T) {
	cache := newListCache(secureTempDirectory(t), time.Now)
	apiOutput := strings.Join([]string{
		`{"id":1,"full_name":"owner/alpha","html_url":"https://github.com/owner/alpha","private":false,"description":null,"archived":false,"fork":false}`,
		`{"id":2,"full_name":"owner/other","html_url":"https://github.com/owner/other","private":false,"description":null,"archived":false,"fork":false}`,
	}, "\n")
	runner := authenticatedRunner(apiOutput)
	app := NewApp(runner)
	app.lists = cache
	app.avatars = nil

	initialFeed := app.Run(context.Background(), "")
	oneCharacterFeed := app.Run(context.Background(), "a")
	otherFeed := app.Run(context.Background(), "ot")

	if len(initialFeed.Items) != 2 {
		t.Fatalf("initial items = %#v, want all repositories", initialFeed.Items)
	}
	if len(oneCharacterFeed.Items) != 1 || oneCharacterFeed.Items[0].Title != "owner/alpha" {
		t.Fatalf("one-character items = %#v, want owner/alpha", oneCharacterFeed.Items)
	}
	if len(otherFeed.Items) != 1 || otherFeed.Items[0].Title != "owner/other" {
		t.Fatalf("other items = %#v, want owner/other", otherFeed.Items)
	}
	if runner.findCalls != 1 || len(runner.commands) != 3 {
		t.Fatalf(
			"GitHub CLI calls = find %d, commands %d, want one fetch sequence",
			runner.findCalls,
			len(runner.commands),
		)
	}
}

// TestAppRunUsesProjectCacheWithoutGitHubCLI はProjectの追加入力もローカル検索になることを検証する。
func TestAppRunUsesProjectCacheWithoutGitHubCLI(t *testing.T) {
	cache := newListCache(secureTempDirectory(t), time.Now)
	if err := cache.StoreProjects([]project{{
		ID:      "PVT_1",
		Number:  1,
		Title:   "Delivery Roadmap",
		HTMLURL: "https://github.com/orgs/example-org/projects/1",
		Public:  true,
		Owner: githubOwner{
			ID:        10,
			NodeID:    "O_1",
			Login:     "example-org",
			AvatarURL: "https://avatars.githubusercontent.com/u/10?v=4",
			Type:      "Organization",
		},
	}}); err != nil {
		t.Fatalf("store project cache: %v", err)
	}
	runner := &fakeRunner{findErr: errors.New("GitHub CLI must not be resolved")}
	app := NewApp(runner)
	app.lists = cache
	app.avatars = nil

	feed := app.Run(context.Background(), "project VERY ROAD")

	if len(feed.Items) != 1 || feed.Items[0].Title != "example-org / Delivery Roadmap" {
		t.Fatalf("cached items = %#v", feed.Items)
	}
	if runner.findCalls != 0 || len(runner.commands) != 0 {
		t.Fatalf("GitHub CLI calls = find %d, commands %d", runner.findCalls, len(runner.commands))
	}
}

// TestNormalizedFilterQueryTrimsAndFoldsCase は1文字を含む検索語の正規化を検証する。
func TestNormalizedFilterQueryTrimsAndFoldsCase(t *testing.T) {
	testCases := []struct {
		name  string
		query string
		want  string
	}{
		{name: "empty", query: "", want: ""},
		{name: "one ASCII character", query: " A ", want: "a"},
		{name: "two ASCII characters", query: " AB ", want: "ab"},
		{name: "one Japanese character", query: " 道 ", want: "道"},
		{name: "two Japanese characters", query: " 道路 ", want: "道路"},
	}

	for _, testCase := range testCases {
		t.Run(testCase.name, func(t *testing.T) {
			got := normalizedFilterQuery(testCase.query)

			if got != testCase.want {
				t.Fatalf("normalized query = %q, want %q", got, testCase.want)
			}
		})
	}
}

// TestAppRunCachesFetchedDataWithoutSearchQuery は検索文字列を保存せず次回入力で再利用する。
func TestAppRunCachesFetchedDataWithoutSearchQuery(t *testing.T) {
	cache := newListCache(secureTempDirectory(t), time.Now)
	runner := authenticatedRunner(
		`{"id":1,"full_name":"owner/repository","html_url":"https://github.com/owner/repository","private":true,"description":null,"archived":false,"fork":false}`,
	)
	app := NewApp(runner)
	app.lists = cache
	app.avatars = nil

	firstFeed := app.Run(context.Background(), "sensitive-filter-value")
	secondFeed := app.Run(context.Background(), "POSIT")

	assertSingleItem(t, firstFeed, "No matching repositories", false, "")
	if len(secondFeed.Items) != 1 || secondFeed.Items[0].Title != "owner/repository" {
		t.Fatalf("cached second items = %#v", secondFeed.Items)
	}
	if len(runner.commands) != 3 {
		t.Fatalf("commands = %d, want one version, auth, and API sequence", len(runner.commands))
	}
	data, err := os.ReadFile(cache.path(repositoryListCacheName))
	if err != nil {
		t.Fatalf("read repository cache: %v", err)
	}
	if strings.Contains(string(data), "sensitive-filter-value") {
		t.Fatal("repository cache contains the Alfred search query")
	}
}

// TestAppRunRequestsBackgroundAvatarRefresh は画像不足が結果表示を待たせないことを検証する。
func TestAppRunRequestsBackgroundAvatarRefresh(t *testing.T) {
	cache := newListCache(secureTempDirectory(t), time.Now)
	if err := cache.StoreRepositories([]repository{{
		ID:       1,
		FullName: "owner/repository",
		HTMLURL:  "https://github.com/owner/repository",
		Owner: githubOwner{
			ID:        10,
			Login:     "owner",
			AvatarURL: "https://avatars.githubusercontent.com/u/10?v=4",
			Type:      "User",
		},
	}}); err != nil {
		t.Fatalf("store repository cache: %v", err)
	}
	avatars := &fakeAvatarProvider{refreshNeeded: true}
	app := NewApp(&fakeRunner{findErr: errors.New("GitHub CLI must not be resolved")})
	app.lists = cache
	app.avatars = avatars

	feed := app.Run(context.Background(), "")

	if !feed.NeedsAvatarRefresh() {
		t.Fatal("feed does not request a background avatar refresh")
	}
	output, err := json.Marshal(feed)
	if err != nil {
		t.Fatalf("marshal feed: %v", err)
	}
	if strings.Contains(string(output), "avatarRefreshNeeded") {
		t.Fatalf("internal refresh state leaked into Alfred JSON: %s", output)
	}
}

// TestRouteInputClassifiesReservedCommands は予約入力と従来検索の境界を検証する。
func TestRouteInputClassifiesReservedCommands(t *testing.T) {
	testCases := []struct {
		name      string
		query     string
		wantMode  inputMode
		wantQuery string
	}{
		{name: "empty repository query", query: "", wantMode: repositoryInput, wantQuery: ""},
		{name: "issue exact", query: "Issue", wantMode: issuesInput},
		{name: "issue with text", query: "issue assigned", wantMode: repositoryInput, wantQuery: "issue assigned"},
		{name: "pull request exact", query: " PRS ", wantMode: pullRequestsInput},
		{name: "project singular", query: "project", wantMode: projectsInput},
		{name: "project plural with query", query: "PROJECTS  Road Map ", wantMode: projectsInput, wantQuery: "Road Map"},
		{name: "project prefix", query: "project-alpha", wantMode: repositoryInput, wantQuery: "project-alpha"},
	}

	for _, testCase := range testCases {
		t.Run(testCase.name, func(t *testing.T) {
			got := routeInput(testCase.query)

			if got.mode != testCase.wantMode || got.query != testCase.wantQuery {
				t.Fatalf("route = %#v, want mode %d and query %q", got, testCase.wantMode, testCase.wantQuery)
			}
		})
	}
}

// TestAppRunShowsLoginItemWhenAuthenticationFailsは未認証時の導線を検証する。
func TestAppRunShowsLoginItemWhenAuthenticationFails(t *testing.T) {
	runner := readyRunner(CommandResult{Err: errors.New("not authenticated")})
	app := NewApp(runner)

	feed := app.Run(context.Background(), "")

	assertSingleItem(t, feed, "Sign in to GitHub", true, "login")
	if len(feed.Items[0].Variables) != 2 {
		t.Fatalf("login variables = %#v, want action and helper", feed.Items[0].Variables)
	}
	helperPath, err := base64.StdEncoding.DecodeString(feed.Items[0].Variables["login_helper"])
	if err != nil {
		t.Fatalf("decode login helper: %v", err)
	}
	if !filepath.IsAbs(string(helperPath)) {
		t.Fatalf("login helper path = %q, want absolute path", helperPath)
	}
	wantArgs := []string{"auth", "status", "--active", "--hostname", "github.com"}
	if !reflect.DeepEqual(runner.commands[1].Args, wantArgs) {
		t.Fatalf("authentication arguments = %#v, want %#v", runner.commands[1].Args, wantArgs)
	}
}

// TestAppRunShowsAuthenticationTimeoutは認証確認のタイムアウト表示を検証する。
func TestAppRunShowsAuthenticationTimeout(t *testing.T) {
	runner := readyRunner(CommandResult{
		Err:      context.DeadlineExceeded,
		TimedOut: true,
	})
	app := NewApp(runner)

	feed := app.Run(context.Background(), "")

	assertSingleItem(t, feed, "Unable to check GitHub authentication", false, "")
}

// TestAppRunDoesNotTreatAuthenticationOverflowAsLogout は異常出力をログアウトと誤認しないことを検証する。
func TestAppRunDoesNotTreatAuthenticationOverflowAsLogout(t *testing.T) {
	runner := readyRunner(CommandResult{
		Err:            context.Canceled,
		StderrOverflow: true,
	})
	app := NewApp(runner)

	feed := app.Run(context.Background(), "")

	assertSingleItem(t, feed, "Unable to check GitHub authentication", false, "")
}

// TestAppRunCreatesPublicAndPrivateItemsは公開状態の表示を検証する。
func TestAppRunCreatesPublicAndPrivateItems(t *testing.T) {
	apiOutput := strings.Join([]string{
		`{"id":1,"full_name":"owner/public","html_url":"https://github.com/owner/public","private":false,"description":"Public repository","archived":false,"fork":false}`,
		`{"id":2,"full_name":"owner/private","html_url":"https://github.com/owner/private","private":true,"description":null,"archived":false,"fork":false}`,
	}, "\n")
	runner := authenticatedRunner(apiOutput)
	app := NewApp(runner)

	feed := app.Run(context.Background(), "")

	if len(feed.Items) != 2 {
		t.Fatalf("item count = %d, want 2", len(feed.Items))
	}
	if feed.Items[0].Subtitle != "Private" {
		t.Errorf("private subtitle = %q, want %q", feed.Items[0].Subtitle, "Private")
	}
	if feed.Items[1].Subtitle != "Public — Public repository" {
		t.Errorf("public subtitle = %q, want %q", feed.Items[1].Subtitle, "Public — Public repository")
	}
}

// TestAppRunMarksArchivedForkはArchivedとForkの表示を検証する。
func TestAppRunMarksArchivedFork(t *testing.T) {
	runner := authenticatedRunner(
		`{"id":3,"full_name":"owner/legacy","html_url":"https://github.com/owner/legacy","private":false,"description":"Old project","archived":true,"fork":true}`,
	)
	app := NewApp(runner)

	feed := app.Run(context.Background(), "")

	if got := feed.Items[0].Subtitle; got != "Public · Archived · Fork — Old project" {
		t.Fatalf("subtitle = %q", got)
	}
}

// TestAppRunCreatesOpenActionはリポジトリ選択時の公開インターフェースを検証する。
func TestAppRunCreatesOpenAction(t *testing.T) {
	runner := authenticatedRunner(
		`{"id":42,"full_name":"octo/repo","html_url":"https://github.com/octo/repo","private":false,"description":null,"archived":false,"fork":false}`,
	)
	app := NewApp(runner)

	feed := app.Run(context.Background(), "")

	item := feed.Items[0]
	if item.UID != "42" || item.Title != "octo/repo" || item.Match != "octo/repo" {
		t.Fatalf("unexpected item identity: %#v", item)
	}
	if item.Arg != "https://github.com/octo/repo" || item.QuickLookURL != item.Arg {
		t.Fatalf("unexpected item URL: %#v", item)
	}
	if item.Variables["action"] != "open" || !item.Valid {
		t.Fatalf("unexpected item action: %#v", item)
	}
}

// TestAppRunAddsOwnerAvatars はOrganizationと個人の所有者画像を検証する。
func TestAppRunAddsOwnerAvatars(t *testing.T) {
	apiOutput := strings.Join([]string{
		`{"id":1,"full_name":"example-org/repo","html_url":"https://github.com/example-org/repo","private":false,"description":null,"archived":false,"fork":false,"owner":{"id":10,"login":"example-org","avatar_url":"https://avatars.githubusercontent.com/u/10?v=4","type":"Organization"}}`,
		`{"id":2,"full_name":"octocat/repo","html_url":"https://github.com/octocat/repo","private":false,"description":null,"archived":false,"fork":false,"owner":{"id":20,"login":"octocat","avatar_url":"https://avatars.githubusercontent.com/u/20?v=4","type":"User"}}`,
	}, "\n")
	runner := authenticatedRunner(apiOutput)
	avatars := &fakeAvatarProvider{
		paths: map[int64]string{
			10: "/cache/avatars/10.png",
			20: "/cache/avatars/20.png",
		},
	}
	app := NewApp(runner)
	app.avatars = avatars

	feed := app.Run(context.Background(), "")

	if feed.Items[0].Icon == nil || feed.Items[0].Icon.Path != "/cache/avatars/10.png" {
		t.Fatalf("organization icon = %#v", feed.Items[0].Icon)
	}
	if feed.Items[1].Icon == nil || feed.Items[1].Icon.Path != "/cache/avatars/20.png" {
		t.Fatalf("user icon = %#v", feed.Items[1].Icon)
	}
	if len(avatars.owners) != 2 ||
		avatars.owners[0].Type != "Organization" ||
		avatars.owners[1].Type != "User" {
		t.Fatalf("owners = %#v", avatars.owners)
	}
}

// TestAppRunMatchesSubstringInsideRepositoryNameはリポジトリ名の語中一致を検証する。
func TestAppRunMatchesSubstringInsideRepositoryName(t *testing.T) {
	apiOutput := strings.Join([]string{
		`{"id":1,"full_name":"owner/alpha-example","html_url":"https://github.com/owner/alpha-example","private":false,"description":null,"archived":false,"fork":false}`,
		`{"id":2,"full_name":"owner/other","html_url":"https://github.com/owner/other","private":false,"description":null,"archived":false,"fork":false}`,
	}, "\n")
	runner := authenticatedRunner(apiOutput)
	app := NewApp(runner)

	feed := app.Run(context.Background(), "PHA-EX")

	if len(feed.Items) != 1 || feed.Items[0].Title != "owner/alpha-example" {
		t.Fatalf("items = %#v", feed.Items)
	}
}

// TestAppRunMatchesSubstringInsideOwnerNameは所有者名の語中一致を検証する。
func TestAppRunMatchesSubstringInsideOwnerName(t *testing.T) {
	runner := authenticatedRunner(
		`{"id":1,"full_name":"example-owner/repo","html_url":"https://github.com/example-owner/repo","private":false,"description":null,"archived":false,"fork":false}`,
	)
	app := NewApp(runner)

	feed := app.Run(context.Background(), "ample-own")

	if len(feed.Items) != 1 || feed.Items[0].Title != "example-owner/repo" {
		t.Fatalf("items = %#v", feed.Items)
	}
}

// TestAppRunShowsNoMatchStateは部分一致する候補がない場合の表示を検証する。
func TestAppRunShowsNoMatchState(t *testing.T) {
	runner := authenticatedRunner(
		`{"id":1,"full_name":"owner/repository","html_url":"https://github.com/owner/repository","private":false,"description":null,"archived":false,"fork":false}`,
	)
	app := NewApp(runner)

	feed := app.Run(context.Background(), "missing")

	assertSingleItem(t, feed, "No matching repositories", false, "")
}

// TestAppRunSortsRepositoriesは大文字小文字を区別しない並び順を検証する。
func TestAppRunSortsRepositories(t *testing.T) {
	apiOutput := strings.Join([]string{
		`{"id":2,"full_name":"zeta/repo","html_url":"https://github.com/zeta/repo","private":false,"description":null,"archived":false,"fork":false}`,
		`{"id":1,"full_name":"Alpha/repo","html_url":"https://github.com/Alpha/repo","private":false,"description":null,"archived":false,"fork":false}`,
	}, "\n")
	runner := authenticatedRunner(apiOutput)
	app := NewApp(runner)

	feed := app.Run(context.Background(), "")

	if feed.Items[0].Title != "Alpha/repo" || feed.Items[1].Title != "zeta/repo" {
		t.Fatalf("unexpected order: %#v", feed.Items)
	}
}

// TestAppRunUsesAccessibleRepositoryEndpointはAPI呼び出し条件を検証する。
func TestAppRunUsesAccessibleRepositoryEndpoint(t *testing.T) {
	runner := authenticatedRunner(
		`{"id":1,"full_name":"owner/repo","html_url":"https://github.com/owner/repo","private":false,"description":null,"archived":false,"fork":false}`,
	)
	app := NewApp(runner)

	_ = app.Run(context.Background(), "")

	wantArgs := []string{
		"api", "/user/repos",
		"--hostname", "github.com",
		"--method", "GET",
		"--paginate",
		"-F", "per_page=100",
		"-f", "visibility=all",
		"-f", "affiliation=owner,collaborator,organization_member",
		"-f", "sort=full_name",
		"-f", "direction=asc",
		"--jq", ".[] | {id, full_name, html_url, private, description, archived, fork, owner: (.owner | {id, login, avatar_url, type})}",
	}
	if !reflect.DeepEqual(runner.commands[2].Args, wantArgs) {
		t.Fatalf("API arguments = %#v, want %#v", runner.commands[2].Args, wantArgs)
	}
}

// TestAppRunShowsEmptyStateは候補がない場合の表示を検証する。
func TestAppRunShowsEmptyState(t *testing.T) {
	runner := authenticatedRunner("")
	app := NewApp(runner)

	feed := app.Run(context.Background(), "")

	assertSingleItem(t, feed, "No repositories found", false, "")
}

// TestAppRunRejectsMalformedJSONは不正なAPI応答を検証する。
func TestAppRunRejectsMalformedJSON(t *testing.T) {
	runner := authenticatedRunner(`{"id":`)
	app := NewApp(runner)

	feed := app.Run(context.Background(), "")

	assertSingleItem(t, feed, "Unable to load repositories", false, "")
}

// TestAppRunShowsAPITimeoutはAPIタイムアウトの表示を検証する。
func TestAppRunShowsAPITimeout(t *testing.T) {
	runner := readyRunner(CommandResult{}, CommandResult{
		Err:      context.DeadlineExceeded,
		TimedOut: true,
	})
	app := NewApp(runner)

	feed := app.Run(context.Background(), "")

	assertSingleItem(t, feed, "Unable to load repositories", false, "")
	if !strings.Contains(feed.Items[0].Subtitle, "did not respond in time") {
		t.Fatalf("subtitle = %q", feed.Items[0].Subtitle)
	}
}

// TestAppRunRejectsOversizedOutputはAPI出力上限を超えた場合を検証する。
func TestAppRunRejectsOversizedOutput(t *testing.T) {
	runner := readyRunner(CommandResult{}, CommandResult{
		Stdout:         []byte(`{"id":1}`),
		StdoutOverflow: true,
	})
	app := NewApp(runner)

	feed := app.Run(context.Background(), "")

	assertSingleItem(t, feed, "Unable to load repositories", false, "")
}

// TestAppRunRejectsOversizedErrorOutput はAPI標準エラー出力の上限超過を検証する。
func TestAppRunRejectsOversizedErrorOutput(t *testing.T) {
	runner := readyRunner(CommandResult{}, CommandResult{
		Stderr:         []byte("unexpected output"),
		StderrOverflow: true,
	})
	app := NewApp(runner)

	feed := app.Run(context.Background(), "")

	assertSingleItem(t, feed, "Unable to load repositories", false, "")
}

// TestAppRunSkipsNonGitHubURLは許可対象外URLの除外を検証する。
func TestAppRunSkipsNonGitHubURL(t *testing.T) {
	apiOutput := strings.Join([]string{
		`{"id":1,"full_name":"owner/unsafe","html_url":"https://example.com/owner/unsafe","private":false,"description":null,"archived":false,"fork":false}`,
		`{"id":2,"full_name":"owner/safe","html_url":"https://github.com/owner/safe","private":false,"description":null,"archived":false,"fork":false}`,
	}, "\n")
	runner := authenticatedRunner(apiOutput)
	app := NewApp(runner)

	feed := app.Run(context.Background(), "")

	if len(feed.Items) != 1 || feed.Items[0].Title != "owner/safe" {
		t.Fatalf("items = %#v", feed.Items)
	}
}

// TestAppRunDoesNotExposeCommandErrorは認証情報を含むエラーの非表示を検証する。
func TestAppRunDoesNotExposeCommandError(t *testing.T) {
	runner := readyRunner(CommandResult{}, CommandResult{
		Err:    errors.New("request failed with secret-token"),
		Stderr: []byte("authorization: secret-token"),
	})
	app := NewApp(runner)

	feed := app.Run(context.Background(), "")

	output, err := json.Marshal(feed)
	if err != nil {
		t.Fatalf("marshal feed: %v", err)
	}
	if strings.Contains(string(output), "secret-token") {
		t.Fatalf("response contains command error: %s", output)
	}
}

// readyRunnerはバージョン確認済みの偽Runnerを初期化する。
func readyRunner(results ...CommandResult) *fakeRunner {
	return &fakeRunner{
		executablePath: "/usr/local/bin/gh",
		results: append(
			[]CommandResult{{Stdout: []byte("gh version 2.96.0 (2026-06-18)\n")}},
			results...,
		),
	}
}

// authenticatedRunnerは認証済みAPI応答を返す偽Runnerを初期化する。
func authenticatedRunner(apiOutput string) *fakeRunner {
	return readyRunner(
		CommandResult{},
		CommandResult{Stdout: []byte(apiOutput)},
	)
}

// assertSingleItemは単一候補の主要な属性を検証する。
func assertSingleItem(t *testing.T, feed Feed, title string, valid bool, action string) {
	t.Helper()

	if len(feed.Items) != 1 {
		t.Fatalf("item count = %d, want 1", len(feed.Items))
	}
	item := feed.Items[0]
	if item.Title != title {
		t.Errorf("title = %q, want %q", item.Title, title)
	}
	if item.Valid != valid {
		t.Errorf("valid = %t, want %t", item.Valid, valid)
	}
	if item.Variables["action"] != action {
		t.Errorf("action = %q, want %q", item.Variables["action"], action)
	}
}

type fakeRunner struct {
	executablePath string
	findErr        error
	results        []CommandResult
	commands       []Command
	findCalls      int
}

type fakeAvatarProvider struct {
	paths         map[int64]string
	owners        []githubOwner
	refreshNeeded bool
}

// Paths はテスト用のアバターパスを返す。
func (provider *fakeAvatarProvider) Paths(owners []githubOwner) avatarPathResult {
	provider.owners = append(provider.owners, owners...)
	return avatarPathResult{
		Paths:         provider.paths,
		RefreshNeeded: provider.refreshNeeded,
	}
}

// FindExecutableはテスト用の実行ファイル検索結果を返す。
func (runner *fakeRunner) FindExecutable(_ string) (string, error) {
	runner.findCalls++
	return runner.executablePath, runner.findErr
}

// Runは登録順にテスト用のコマンド結果を返す。
func (runner *fakeRunner) Run(_ context.Context, command Command) CommandResult {
	runner.commands = append(runner.commands, command)
	resultIndex := len(runner.commands) - 1
	if resultIndex >= len(runner.results) {
		return CommandResult{Err: errors.New("unexpected command")}
	}

	return runner.results[resultIndex]
}
