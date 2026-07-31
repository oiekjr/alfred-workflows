package githubrepos

import (
	"os"
	"strings"
	"testing"
)

// TestWorkflowUsesRestrictedAuthenticationHelper はTerminalから同梱ヘルパーだけを呼ぶことを検証する。
func TestWorkflowUsesRestrictedAuthenticationHelper(t *testing.T) {
	plist, err := os.ReadFile("../../workflows/github-repositories/info.plist")
	if err != nil {
		t.Fatalf("read workflow definition: %v", err)
	}
	definition := string(plist)

	if !strings.Contains(definition, "{var:login_helper}") ||
		!strings.Contains(definition, "/usr/bin/base64 -D") ||
		!strings.Contains(definition, "\"$helper_path\" --authentication-helper login") ||
		!strings.Contains(definition, "\"$helper_path\" --authentication-helper login-projects") ||
		!strings.Contains(definition, "\"$helper_path\" --authentication-helper authorize-projects") {
		t.Fatal("workflow does not decode and execute the absolute authentication helper")
	}
	for _, forbiddenValue := range []string{
		"--clipboard",
		"--show-token",
		"<string>gh auth login",
		"<string>gh auth refresh",
		"{var:gh_path}",
		"./github-repositories --login",
		"\"$helper_path\" --login",
	} {
		if strings.Contains(definition, forbiddenValue) {
			t.Errorf("workflow contains forbidden authentication value %q", forbiddenValue)
		}
	}
}

// TestWorkflowDeclaresGitHubNavigatorActions は表示名、バージョン、固定アクションを検証する。
func TestWorkflowDeclaresGitHubNavigatorActions(t *testing.T) {
	plist, err := os.ReadFile("../../workflows/github-repositories/info.plist")
	if err != nil {
		t.Fatalf("read workflow definition: %v", err)
	}
	definition := string(plist)

	for _, requiredValue := range []string{
		"<string>GitHub Navigator</string>",
		"<string>0.2.2</string>",
		"<string>login-projects</string>",
		"<string>authorize-projects</string>",
	} {
		if !strings.Contains(definition, requiredValue) {
			t.Errorf("workflow does not contain %q", requiredValue)
		}
	}
}

// TestWorkflowDebouncesSlowAPIQueries は初回入力を即時実行しつつ追加入力を抑制する。
func TestWorkflowDebouncesSlowAPIQueries(t *testing.T) {
	plist, err := os.ReadFile("../../workflows/github-repositories/info.plist")
	if err != nil {
		t.Fatalf("read workflow definition: %v", err)
	}
	definition := string(plist)

	for _, requiredSetting := range []string{
		"<key>queuedelaycustom</key>\n\t\t\t\t<integer>3</integer>",
		"<key>queuedelayimmediatelyinitially</key>\n\t\t\t\t<true/>",
		"<key>queuedelaymode</key>\n\t\t\t\t<integer>2</integer>",
		"<key>queuemode</key>\n\t\t\t\t<integer>1</integer>",
	} {
		if !strings.Contains(definition, requiredSetting) {
			t.Errorf("workflow does not contain run setting %q", requiredSetting)
		}
	}
}
