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
	"unicode/utf8"
)

const (
	projectReadScope        = "read:project"
	projectWriteScope       = "project"
	projectDescriptionLimit = 4 * 1024
)

const projectGraphQLQuery = `query($endCursor: String) {
  viewer {
    id
    login
    avatarUrl
    projectsV2(
      first: 100
      minPermissionLevel: READ
      orderBy: {field: TITLE, direction: ASC}
    ) {
      nodes {
        id
        number
        title
        url
        shortDescription
        public
        closed
      }
    }
    organizations(first: 100, after: $endCursor) {
      nodes {
        id
        login
        avatarUrl
        projectsV2(
          first: 100
          minPermissionLevel: READ
          orderBy: {field: TITLE, direction: ASC}
        ) {
          nodes {
            id
            number
            title
            url
            shortDescription
            public
            closed
          }
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
}`

const projectJQExpression = `.data.viewer as $viewer |
(
  {
    owner: {
      node_id: $viewer.id,
      login: $viewer.login,
      avatar_url: $viewer.avatarUrl,
      type: "User"
    },
    projects: $viewer.projectsV2.nodes
  },
  (
    $viewer.organizations.nodes[] |
    {
      owner: {
        node_id: .id,
        login: .login,
        avatar_url: .avatarUrl,
        type: "Organization"
      },
      projects: .projectsV2.nodes
    }
  )
) |
.owner as $owner |
.projects[] |
{
  id,
  number,
  title,
  html_url: .url,
  short_description: .shortDescription,
  public,
  closed,
  owner: $owner
}`

// runProjects は閲覧可能なProjectを取得してAlfred向け応答を生成する。
func (app App) runProjects(ctx context.Context, githubCLIPath string, query string) Feed {
	projectsResult := app.runner.Run(ctx, Command{
		Path: githubCLIPath,
		Args: []string{
			"api", "graphql",
			"--hostname", githubHostname,
			"--method", "POST",
			"--paginate",
			"-f", "query=" + projectGraphQLQuery,
			"--jq", projectJQExpression,
		},
		Timeout:     apiTimeout,
		StdoutLimit: apiOutputLimit,
		StderrLimit: stderrLimit,
	})
	if commandFailed(projectsResult) {
		return projectFailureFeed(projectsResult.TimedOut)
	}

	projects, err := parseProjects(projectsResult.Stdout)
	if err != nil {
		return projectFailureFeed(false)
	}
	if len(projects) == 0 {
		return emptyProjectFeed()
	}

	matchingProjects, validProjectCount, openProjectCount := filterProjects(projects, query)
	if validProjectCount == 0 {
		return projectFailureFeed(false)
	}
	if openProjectCount == 0 {
		return emptyProjectFeed()
	}
	if len(matchingProjects) == 0 {
		return noMatchingProjectFeed()
	}

	avatarPaths := make(map[int64]string)
	if app.avatars != nil {
		avatarPaths = app.avatars.Paths(ctx, projectOwners(matchingProjects))
	}

	return Feed{Items: projectItems(matchingProjects, avatarPaths)}
}

// parseProjects は改行区切りのGitHub GraphQL応答を解析する。
func parseProjects(output []byte) ([]project, error) {
	decoder := json.NewDecoder(bytes.NewReader(output))
	projects := make([]project, 0)

	for {
		var value project
		err := decoder.Decode(&value)
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("decode project: %w", err)
		}

		value.Owner = ownerWithAvatarID(value.Owner)
		projects = append(projects, value)
	}

	return projects, nil
}

// ownerWithAvatarID は検証可能なアバターURLから数値の所有者IDを補完する。
func ownerWithAvatarID(owner githubOwner) githubOwner {
	if owner.ID > 0 {
		return owner
	}

	avatarURL, err := url.Parse(owner.AvatarURL)
	if err != nil {
		return owner
	}
	ownerID, err := avatarOwnerIDFromURL(avatarURL)
	if err == nil {
		owner.ID = ownerID
	}

	return owner
}

// filterProjects は安全性を検証し、Openかつ検索語を含むProjectを抽出する。
func filterProjects(projects []project, query string) ([]project, int, int) {
	normalizedQuery := strings.ToLower(strings.TrimSpace(query))
	matches := make([]project, 0, len(projects))
	seenProjectIDs := make(map[string]struct{})
	validProjectCount := 0
	openProjectCount := 0

	for _, value := range projects {
		value.Title = normalizedDisplayText(value.Title)
		value.ShortDescription = boundedDisplayText(
			value.ShortDescription,
			projectDescriptionLimit,
		)
		if !isValidProject(value) {
			continue
		}
		if _, exists := seenProjectIDs[value.ID]; exists {
			continue
		}
		seenProjectIDs[value.ID] = struct{}{}
		validProjectCount++
		if value.Closed {
			continue
		}
		openProjectCount++

		ownerMatches := strings.Contains(strings.ToLower(value.Owner.Login), normalizedQuery)
		titleMatches := strings.Contains(strings.ToLower(value.Title), normalizedQuery)
		if normalizedQuery != "" && !ownerMatches && !titleMatches {
			continue
		}

		matches = append(matches, value)
	}

	sort.SliceStable(matches, func(leftIndex, rightIndex int) bool {
		leftOwner := strings.ToLower(matches[leftIndex].Owner.Login)
		rightOwner := strings.ToLower(matches[rightIndex].Owner.Login)
		if leftOwner != rightOwner {
			return leftOwner < rightOwner
		}

		leftTitle := strings.ToLower(matches[leftIndex].Title)
		rightTitle := strings.ToLower(matches[rightIndex].Title)
		if leftTitle != rightTitle {
			return leftTitle < rightTitle
		}

		return matches[leftIndex].Number < matches[rightIndex].Number
	})

	return matches, validProjectCount, openProjectCount
}

// normalizedDisplayText は外部入力の改行や連続空白を表示用に正規化する。
func normalizedDisplayText(value string) string {
	return strings.Join(strings.Fields(value), " ")
}

// boundedDisplayText は表示文字列をUTF-8境界を保って指定バイト数へ制限する。
func boundedDisplayText(value string, limit int) string {
	normalizedValue := normalizedDisplayText(value)
	if limit <= 0 || len(normalizedValue) <= limit {
		return normalizedValue
	}

	truncatedValue := normalizedValue[:limit]
	for !utf8.ValidString(truncatedValue) {
		truncatedValue = truncatedValue[:len(truncatedValue)-1]
	}

	return strings.TrimSpace(truncatedValue) + "…"
}

// isValidProject はProjectの識別情報と遷移先を検証する。
func isValidProject(value project) bool {
	return value.ID != "" &&
		len(value.ID) <= 256 &&
		value.Number > 0 &&
		value.Title != "" &&
		len(value.Title) <= 1024 &&
		isValidProjectOwner(value.Owner) &&
		isGitHubProjectURL(value.HTMLURL, value.Owner, value.Number)
}

// isValidProjectOwner はProject所有者の識別情報を検証する。
func isValidProjectOwner(owner githubOwner) bool {
	return owner.NodeID != "" &&
		len(owner.NodeID) <= 256 &&
		isGitHubLogin(owner.Login) &&
		(owner.Type == "Organization" || owner.Type == "User")
}

// isGitHubLogin はGitHub.comのユーザー名またはOrganization名を検証する。
func isGitHubLogin(login string) bool {
	if len(login) == 0 ||
		len(login) > 39 ||
		login[0] == '-' ||
		login[len(login)-1] == '-' {
		return false
	}

	for _, character := range login {
		if (character >= 'a' && character <= 'z') ||
			(character >= 'A' && character <= 'Z') ||
			(character >= '0' && character <= '9') ||
			character == '-' {
			continue
		}

		return false
	}

	return true
}

// isGitHubProjectURL はGitHub.com上の対象Project URLだけを許可する。
func isGitHubProjectURL(rawURL string, owner githubOwner, number int) bool {
	parsedURL, err := url.Parse(rawURL)
	if err != nil {
		return false
	}

	var ownerPath string
	switch owner.Type {
	case "Organization":
		ownerPath = "/orgs/"
	case "User":
		ownerPath = "/users/"
	default:
		return false
	}

	expectedPath := ownerPath + owner.Login + "/projects/" + strconv.Itoa(number)
	expectedURL := "https://" + githubHostname + expectedPath

	return rawURL == expectedURL &&
		parsedURL.Scheme == "https" &&
		parsedURL.Host == githubHostname &&
		parsedURL.User == nil &&
		parsedURL.RawQuery == "" &&
		parsedURL.Fragment == "" &&
		parsedURL.RawPath == "" &&
		parsedURL.Opaque == "" &&
		parsedURL.Path == expectedPath
}

// projectOwners はProjectから所有者情報を抽出する。
func projectOwners(projects []project) []githubOwner {
	owners := make([]githubOwner, 0, len(projects))
	for _, value := range projects {
		owners = append(owners, value.Owner)
	}

	return owners
}

// projectItems はProjectをAlfred候補へ変換する。
func projectItems(projects []project, avatarPaths map[int64]string) []Item {
	items := make([]Item, 0, len(projects))
	for _, value := range projects {
		item := Item{
			UID:          "project:" + value.ID,
			Title:        value.Owner.Login + " / " + value.Title,
			Subtitle:     projectSubtitle(value),
			Arg:          value.HTMLURL,
			Match:        value.Owner.Login + " " + value.Title,
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

// projectSubtitle は公開状態、番号、説明を読みやすく連結する。
func projectSubtitle(value project) string {
	visibility := "Private"
	if value.Public {
		visibility = "Public"
	}

	subtitle := visibility + " · Project #" + strconv.Itoa(value.Number)
	if value.ShortDescription == "" {
		return subtitle
	}

	return subtitle + " — " + value.ShortDescription
}

// projectLoginFeed はProject読取権限を含むGitHub CLI認証候補を生成する。
func projectLoginFeed(helperToken string) Feed {
	if helperToken == "" {
		return failureFeed(
			"Unable to start GitHub authentication",
			"Reinstall the workflow, then try again.",
		)
	}

	return Feed{Items: []Item{{
		Title:    "Sign in to GitHub for Projects",
		Subtitle: "Press Return to authenticate with read-only Projects access.",
		Valid:    true,
		Variables: map[string]string{
			"action":       "login-projects",
			"login_helper": helperToken,
		},
	}}}
}

// projectAuthorizationFeed は既存認証へProject読取権限を追加する候補を生成する。
func projectAuthorizationFeed(helperToken string) Feed {
	if helperToken == "" {
		return failureFeed(
			"Unable to authorize GitHub Projects",
			"Reinstall the workflow, then try again.",
		)
	}

	return Feed{Items: []Item{{
		Title:    "Authorize GitHub Projects",
		Subtitle: "Press Return to add read-only Projects access to GitHub CLI.",
		Valid:    true,
		Variables: map[string]string{
			"action":       "authorize-projects",
			"login_helper": helperToken,
		},
	}}}
}

// emptyProjectFeed は閲覧可能なOpen Projectがない状態を通知する。
func emptyProjectFeed() Feed {
	return failureFeed(
		"No open projects found",
		"The active GitHub account has no accessible open projects.",
	)
}

// noMatchingProjectFeed は検索語に一致するProjectがない状態を通知する。
func noMatchingProjectFeed() Feed {
	return failureFeed(
		"No matching projects",
		"No project owner or title contains your query.",
	)
}

// projectFailureFeed はProject一覧を取得できない状態を通知する。
func projectFailureFeed(timedOut bool) Feed {
	if timedOut {
		return failureFeed(
			"Unable to load projects",
			"GitHub did not respond in time. Try again.",
		)
	}

	return failureFeed(
		"Unable to load projects",
		"Check your connection, GitHub CLI authentication, and Organization access.",
	)
}

type project struct {
	ID               string      `json:"id"`
	Number           int         `json:"number"`
	Title            string      `json:"title"`
	HTMLURL          string      `json:"html_url"`
	ShortDescription string      `json:"short_description"`
	Public           bool        `json:"public"`
	Closed           bool        `json:"closed"`
	Owner            githubOwner `json:"owner"`
}
