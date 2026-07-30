package githubrepos

import (
	"os"
	"strings"
	"testing"
)

// TestWorkflowUsesRestrictedLoginHelper はTerminalから同梱ヘルパーだけを呼ぶことを検証する。
func TestWorkflowUsesRestrictedLoginHelper(t *testing.T) {
	plist, err := os.ReadFile("../../workflows/github-repositories/info.plist")
	if err != nil {
		t.Fatalf("read workflow definition: %v", err)
	}
	definition := string(plist)

	if !strings.Contains(definition, "{var:login_helper}") ||
		!strings.Contains(definition, "/usr/bin/base64 -D") ||
		!strings.Contains(definition, "\"$helper_path\" --login") {
		t.Fatal("workflow does not decode and execute the absolute login helper")
	}
	for _, forbiddenValue := range []string{
		"--clipboard",
		"<string>gh auth login",
		"{var:gh_path}",
		"./github-repositories --login",
	} {
		if strings.Contains(definition, forbiddenValue) {
			t.Errorf("workflow contains forbidden login value %q", forbiddenValue)
		}
	}
}
