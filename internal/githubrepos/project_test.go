package githubrepos

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"
	"unicode/utf8"
)

// TestAppRunListsOpenProjectsWithOwnerAvatars はProject表示、並び順、重複排除を検証する。
func TestAppRunListsOpenProjectsWithOwnerAvatars(t *testing.T) {
	apiOutput := strings.Join([]string{
		`{"id":"PVT_org_2","number":2,"title":"  Zebra   Roadmap ","html_url":"https://github.com/orgs/beta-org/projects/2","short_description":" Delivery   plan ","public":false,"closed":false,"owner":{"node_id":"O_org","login":"beta-org","avatar_url":"https://avatars.githubusercontent.com/u/20?v=4","type":"Organization"}}`,
		`{"id":"PVT_user_1","number":1,"title":"Alpha Board","html_url":"https://github.com/users/alpha-user/projects/1","short_description":"","public":true,"closed":false,"owner":{"node_id":"U_user","login":"alpha-user","avatar_url":"https://avatars.githubusercontent.com/u/10?v=4","type":"User"}}`,
		`{"id":"PVT_user_1","number":1,"title":"Alpha Board","html_url":"https://github.com/users/alpha-user/projects/1","short_description":"","public":true,"closed":false,"owner":{"node_id":"U_user","login":"alpha-user","avatar_url":"https://avatars.githubusercontent.com/u/10?v=4","type":"User"}}`,
		`{"id":"PVT_org_3","number":3,"title":"Closed Board","html_url":"https://github.com/orgs/beta-org/projects/3","short_description":"","public":true,"closed":true,"owner":{"node_id":"O_org","login":"beta-org","avatar_url":"https://avatars.githubusercontent.com/u/20?v=4","type":"Organization"}}`,
	}, "\n")
	runner := authenticatedProjectRunner(apiOutput)
	avatars := &fakeAvatarProvider{paths: map[int64]string{
		10: "/cache/avatars/10.png",
		20: "/cache/avatars/20.png",
	}}
	app := NewApp(runner)
	app.avatars = avatars

	feed := app.Run(context.Background(), "projects")

	if len(feed.Items) != 2 {
		t.Fatalf("item count = %d, want 2: %#v", len(feed.Items), feed.Items)
	}
	userProject := feed.Items[0]
	if userProject.UID != "project:PVT_user_1" ||
		userProject.Title != "alpha-user / Alpha Board" ||
		userProject.Subtitle != "Public · Project #1" ||
		userProject.Arg != "https://github.com/users/alpha-user/projects/1" ||
		userProject.QuickLookURL != userProject.Arg ||
		userProject.Variables["action"] != "open" ||
		!userProject.Valid {
		t.Fatalf("user project item = %#v", userProject)
	}
	if userProject.Icon == nil || userProject.Icon.Path != "/cache/avatars/10.png" {
		t.Fatalf("user project icon = %#v", userProject.Icon)
	}

	organizationProject := feed.Items[1]
	if organizationProject.Title != "beta-org / Zebra Roadmap" ||
		organizationProject.Subtitle != "Private · Project #2 — Delivery plan" {
		t.Fatalf("organization project item = %#v", organizationProject)
	}
	if organizationProject.Icon == nil || organizationProject.Icon.Path != "/cache/avatars/20.png" {
		t.Fatalf("organization project icon = %#v", organizationProject.Icon)
	}
	if len(avatars.owners) != 2 ||
		avatars.owners[0].ID != 10 ||
		avatars.owners[0].Type != "User" ||
		avatars.owners[1].ID != 20 ||
		avatars.owners[1].Type != "Organization" {
		t.Fatalf("avatar owners = %#v", avatars.owners)
	}
}

// TestAppRunFiltersProjectsByOwnerOrTitle は所有者名と題名の部分一致を検証する。
func TestAppRunFiltersProjectsByOwnerOrTitle(t *testing.T) {
	apiOutput := strings.Join([]string{
		`{"id":"PVT_1","number":1,"title":"Delivery Roadmap","html_url":"https://github.com/orgs/example-org/projects/1","short_description":"","public":true,"closed":false,"owner":{"node_id":"O_1","login":"example-org","avatar_url":"https://avatars.githubusercontent.com/u/10?v=4","type":"Organization"}}`,
		`{"id":"PVT_2","number":2,"title":"Operations","html_url":"https://github.com/orgs/another-org/projects/2","short_description":"","public":false,"closed":false,"owner":{"node_id":"O_2","login":"another-org","avatar_url":"https://avatars.githubusercontent.com/u/20?v=4","type":"Organization"}}`,
	}, "\n")
	testCases := []struct {
		name      string
		query     string
		wantTitle string
	}{
		{name: "title substring", query: "projects VERY ROAD", wantTitle: "example-org / Delivery Roadmap"},
		{name: "owner substring", query: "project OTHER-OR", wantTitle: "another-org / Operations"},
	}

	for _, testCase := range testCases {
		t.Run(testCase.name, func(t *testing.T) {
			runner := authenticatedProjectRunner(apiOutput)
			app := NewApp(runner)

			feed := app.Run(context.Background(), testCase.query)

			if len(feed.Items) != 1 || feed.Items[0].Title != testCase.wantTitle {
				t.Fatalf("items = %#v", feed.Items)
			}
		})
	}
}

// TestAppRunShowsProjectNoMatchState はProjectの部分一致がない状態を検証する。
func TestAppRunShowsProjectNoMatchState(t *testing.T) {
	runner := authenticatedProjectRunner(
		`{"id":"PVT_1","number":1,"title":"Roadmap","html_url":"https://github.com/orgs/example-org/projects/1","short_description":"","public":true,"closed":false,"owner":{"node_id":"O_1","login":"example-org","avatar_url":"https://avatars.githubusercontent.com/u/10?v=4","type":"Organization"}}`,
	)
	app := NewApp(runner)

	feed := app.Run(context.Background(), "project missing")

	assertSingleItem(t, feed, "No matching projects", false, "")
}

// TestAppRunShowsEmptyProjectState はOpen Projectがない状態を検証する。
func TestAppRunShowsEmptyProjectState(t *testing.T) {
	testCases := []struct {
		name      string
		apiOutput string
	}{
		{name: "no projects", apiOutput: ""},
		{
			name:      "closed projects only",
			apiOutput: `{"id":"PVT_1","number":1,"title":"Closed","html_url":"https://github.com/orgs/example-org/projects/1","short_description":"","public":true,"closed":true,"owner":{"node_id":"O_1","login":"example-org","avatar_url":"https://avatars.githubusercontent.com/u/10?v=4","type":"Organization"}}`,
		},
	}

	for _, testCase := range testCases {
		t.Run(testCase.name, func(t *testing.T) {
			runner := authenticatedProjectRunner(testCase.apiOutput)
			app := NewApp(runner)

			feed := app.Run(context.Background(), "project")

			assertSingleItem(t, feed, "No open projects found", false, "")
		})
	}
}

// TestAppRunUsesFixedProjectGraphQLQuery は検索文字列をAPIへ渡さないことを検証する。
func TestAppRunUsesFixedProjectGraphQLQuery(t *testing.T) {
	runner := authenticatedProjectRunner(
		`{"id":"PVT_1","number":1,"title":"private-search-value","html_url":"https://github.com/orgs/example-org/projects/1","short_description":"","public":true,"closed":false,"owner":{"node_id":"O_1","login":"example-org","avatar_url":"https://avatars.githubusercontent.com/u/10?v=4","type":"Organization"}}`,
	)
	app := NewApp(runner)

	_ = app.Run(context.Background(), "project private-search-value")

	wantArgs := []string{
		"api", "graphql",
		"--hostname", "github.com",
		"--method", "POST",
		"--paginate",
		"-f", "query=" + projectGraphQLQuery,
		"--jq", projectJQExpression,
	}
	if !reflect.DeepEqual(runner.commands[2].Args, wantArgs) {
		t.Fatalf("Project API arguments = %#v, want %#v", runner.commands[2].Args, wantArgs)
	}
	for _, argument := range runner.commands[2].Args {
		if strings.Contains(argument, "private-search-value") {
			t.Fatalf("Project API argument contains search query: %q", argument)
		}
	}
	if runner.commands[2].Timeout != apiTimeout ||
		runner.commands[2].StdoutLimit != apiOutputLimit ||
		runner.commands[2].StderrLimit != stderrLimit {
		t.Fatalf("Project API limits = %#v", runner.commands[2])
	}
}

// TestAppRunRejectsInvalidProjectData は不正なProject識別情報とURLを除外する。
func TestAppRunRejectsInvalidProjectData(t *testing.T) {
	apiOutput := strings.Join([]string{
		`{"id":"PVT_external","number":1,"title":"External","html_url":"https://example.com/orgs/example-org/projects/1","short_description":"","public":true,"closed":false,"owner":{"node_id":"O_1","login":"example-org","avatar_url":"https://avatars.githubusercontent.com/u/10?v=4","type":"Organization"}}`,
		`{"id":"PVT_query","number":2,"title":"Query","html_url":"https://github.com/orgs/example-org/projects/2?tab=1","short_description":"","public":true,"closed":false,"owner":{"node_id":"O_1","login":"example-org","avatar_url":"https://avatars.githubusercontent.com/u/10?v=4","type":"Organization"}}`,
		`{"id":"PVT_wrong_owner","number":3,"title":"Wrong owner","html_url":"https://github.com/orgs/other-org/projects/3","short_description":"","public":true,"closed":false,"owner":{"node_id":"O_1","login":"example-org","avatar_url":"https://avatars.githubusercontent.com/u/10?v=4","type":"Organization"}}`,
		`{"id":"PVT_wrong_type","number":4,"title":"Wrong type","html_url":"https://github.com/orgs/example-org/projects/4","short_description":"","public":true,"closed":false,"owner":{"node_id":"U_1","login":"example-org","avatar_url":"https://avatars.githubusercontent.com/u/10?v=4","type":"User"}}`,
		`{"id":"","number":5,"title":"Missing ID","html_url":"https://github.com/orgs/example-org/projects/5","short_description":"","public":true,"closed":false,"owner":{"node_id":"O_1","login":"example-org","avatar_url":"https://avatars.githubusercontent.com/u/10?v=4","type":"Organization"}}`,
		`{"id":"PVT_missing_owner","number":6,"title":"Missing owner ID","html_url":"https://github.com/orgs/example-org/projects/6","short_description":"","public":true,"closed":false,"owner":{"node_id":"","login":"example-org","avatar_url":"https://avatars.githubusercontent.com/u/10?v=4","type":"Organization"}}`,
		`{"id":"PVT_safe","number":7,"title":"Safe","html_url":"https://github.com/orgs/example-org/projects/7","short_description":"","public":true,"closed":false,"owner":{"node_id":"O_1","login":"example-org","avatar_url":"https://avatars.githubusercontent.com/u/10?v=4","type":"Organization"}}`,
	}, "\n")
	runner := authenticatedProjectRunner(apiOutput)
	app := NewApp(runner)

	feed := app.Run(context.Background(), "project")

	if len(feed.Items) != 1 || feed.Items[0].Title != "example-org / Safe" {
		t.Fatalf("items = %#v", feed.Items)
	}
}

// TestAppRunHandlesProjectAuthentication はProject用ログインと権限追加を検証する。
func TestAppRunHandlesProjectAuthentication(t *testing.T) {
	testCases := []struct {
		name       string
		authResult CommandResult
		wantTitle  string
		wantAction string
	}{
		{
			name:       "not authenticated",
			authResult: CommandResult{Err: errors.New("not authenticated")},
			wantTitle:  "Sign in to GitHub for Projects",
			wantAction: "login-projects",
		},
		{
			name:       "missing read scope",
			authResult: CommandResult{Stdout: []byte(authStatusWithScopes("repo", "read:org"))},
			wantTitle:  "Authorize GitHub Projects",
			wantAction: "authorize-projects",
		},
	}

	for _, testCase := range testCases {
		t.Run(testCase.name, func(t *testing.T) {
			runner := readyRunner(testCase.authResult)
			app := NewApp(runner)

			feed := app.Run(context.Background(), "project")

			assertSingleItem(t, feed, testCase.wantTitle, true, testCase.wantAction)
			if feed.Items[0].Variables["login_helper"] == "" {
				t.Fatal("authentication helper is empty")
			}
			if len(runner.commands) != 2 {
				t.Fatalf("commands = %d, want version and authentication only", len(runner.commands))
			}
		})
	}
}

// TestHasProjectReadScopeAcceptsReadAndWriteScopes はProject権限の判定を検証する。
func TestHasProjectReadScopeAcceptsReadAndWriteScopes(t *testing.T) {
	testCases := []struct {
		name   string
		scopes []string
		want   bool
	}{
		{name: "read scope", scopes: []string{"repo", "read:project"}, want: true},
		{name: "write scope", scopes: []string{"repo", "project"}, want: true},
		{name: "unrelated scopes", scopes: []string{"repo", "read:org"}, want: false},
		{name: "missing scope output", scopes: nil, want: false},
	}

	for _, testCase := range testCases {
		t.Run(testCase.name, func(t *testing.T) {
			output := []byte("")
			if testCase.scopes != nil {
				output = []byte(authStatusWithScopes(testCase.scopes...))
			}

			got := hasProjectReadScope(output)

			if got != testCase.want {
				t.Fatalf("hasProjectReadScope() = %t, want %t", got, testCase.want)
			}
		})
	}
}

// TestBoundedDisplayTextPreservesUTF8 は説明文の上限とUTF-8境界を検証する。
func TestBoundedDisplayTextPreservesUTF8(t *testing.T) {
	value := `abあcd "quoted"`

	got := boundedDisplayText(value, 4)

	if got != "ab…" {
		t.Fatalf("bounded text = %q, want %q", got, "ab…")
	}
	if !utf8.ValidString(got) {
		t.Fatalf("bounded text is invalid UTF-8: %q", got)
	}
}

// TestAppRunHandlesProjectAPIFailures はProject APIの失敗を安全に表示する。
func TestAppRunHandlesProjectAPIFailures(t *testing.T) {
	testCases := []struct {
		name       string
		apiResult  CommandResult
		wantDetail string
	}{
		{
			name:       "timeout",
			apiResult:  CommandResult{Err: context.DeadlineExceeded, TimedOut: true},
			wantDetail: "did not respond in time",
		},
		{
			name:      "stdout overflow",
			apiResult: CommandResult{StdoutOverflow: true},
		},
		{
			name:      "stderr overflow",
			apiResult: CommandResult{StderrOverflow: true},
		},
		{
			name:      "malformed JSON",
			apiResult: CommandResult{Stdout: []byte(`{"id":`)},
		},
		{
			name: "secret error",
			apiResult: CommandResult{
				Err:    errors.New("request failed with secret-token"),
				Stderr: []byte("authorization: secret-token"),
			},
		},
	}

	for _, testCase := range testCases {
		t.Run(testCase.name, func(t *testing.T) {
			runner := readyRunner(
				CommandResult{Stdout: []byte(authStatusWithScopes(projectReadScope))},
				testCase.apiResult,
			)
			app := NewApp(runner)

			feed := app.Run(context.Background(), "project")

			assertSingleItem(t, feed, "Unable to load projects", false, "")
			if testCase.wantDetail != "" && !strings.Contains(feed.Items[0].Subtitle, testCase.wantDetail) {
				t.Fatalf("subtitle = %q", feed.Items[0].Subtitle)
			}
			output, err := json.Marshal(feed)
			if err != nil {
				t.Fatalf("marshal feed: %v", err)
			}
			if strings.Contains(string(output), "secret-token") {
				t.Fatalf("response contains command error: %s", output)
			}
		})
	}
}

// authenticatedProjectRunner はProject権限を持つ認証済みAPI応答を返す偽Runnerを初期化する。
func authenticatedProjectRunner(apiOutput string) *fakeRunner {
	return readyRunner(
		CommandResult{Stdout: []byte(authStatusWithScopes("repo", "read:org", projectReadScope))},
		CommandResult{Stdout: []byte(apiOutput)},
	)
}

// authStatusWithScopes はGitHub CLIの認証状態出力を組み立てる。
func authStatusWithScopes(scopes ...string) string {
	quotedScopes := make([]string, 0, len(scopes))
	for _, scope := range scopes {
		quotedScopes = append(quotedScopes, "'"+scope+"'")
	}

	return "github.com\n  ✓ Logged in to github.com account octocat\n" +
		"  - Token scopes: " + strings.Join(quotedScopes, ", ") + "\n"
}
