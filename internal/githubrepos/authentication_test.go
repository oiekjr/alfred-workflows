package githubrepos

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestParseAuthenticationStatusExtractsOnlyAccountData は認証出力から非秘密情報だけを抽出する。
func TestParseAuthenticationStatusExtractsOnlyAccountData(t *testing.T) {
	output := strings.Join([]string{
		"github.com",
		"  ✓ Logged in to github.com account Octo-Cat (/Users/octocat/.config/gh/hosts.yml)",
		"  - Active account: true",
		"  - Git operations protocol: https",
		"  - Token: secret-token-must-not-be-retained",
		"  - Token scopes: 'repo', 'read:org', 'read:project'",
	}, "\n")

	status, ok := parseAuthenticationStatus([]byte(output))

	if !ok {
		t.Fatal("authentication status was rejected")
	}
	if status.Hostname != githubHostname ||
		status.Login != "octo-cat" ||
		status.Scopes != "'repo', 'read:org', 'read:project'" {
		t.Fatalf("authentication status = %#v", status)
	}
	if strings.Contains(
		status.Hostname+status.Login+status.Scopes,
		"secret-token",
	) {
		t.Fatalf("authentication status retained token data: %#v", status)
	}
}

// TestParseAuthenticationStatusRejectsAmbiguousAccount は曖昧または不正な主体を拒否する。
func TestParseAuthenticationStatusRejectsAmbiguousAccount(t *testing.T) {
	testCases := []struct {
		name   string
		output string
	}{
		{name: "empty", output: ""},
		{
			name:   "invalid login",
			output: "Logged in to github.com account invalid/login (hosts.yml)",
		},
		{
			name: "duplicate active account",
			output: strings.Join([]string{
				"Logged in to github.com account octocat (hosts.yml)",
				"Logged in to github.com account hubot (hosts.yml)",
			}, "\n"),
		},
		{
			name:   "different hostname",
			output: "Logged in to example.com account octocat (hosts.yml)",
		},
	}

	for _, testCase := range testCases {
		t.Run(testCase.name, func(t *testing.T) {
			_, ok := parseAuthenticationStatus([]byte(testCase.output))

			if ok {
				t.Fatal("invalid authentication status was accepted")
			}
		})
	}
}

// TestGitHubConfigIdentityAtUsesMetadataOnly は標準設定ファイルの同一性変化を検出する。
func TestGitHubConfigIdentityAtUsesMetadataOnly(t *testing.T) {
	homeDirectory := secureTempDirectory(t)
	configDirectory := filepath.Join(homeDirectory, githubConfigDirectory)
	if err := os.MkdirAll(configDirectory, 0o700); err != nil {
		t.Fatalf("create GitHub config directory: %v", err)
	}
	configPath := filepath.Join(configDirectory, githubHostsFileName)
	if err := os.WriteFile(
		configPath,
		[]byte("github.com:\n  user: octocat\n"),
		0o600,
	); err != nil {
		t.Fatalf("write GitHub config: %v", err)
	}

	firstIdentity, ok := githubConfigIdentityAt(homeDirectory)
	if !ok {
		t.Fatal("private GitHub config identity is unavailable")
	}
	if err := os.WriteFile(
		configPath,
		[]byte("github.com:\n  user: another-account\n"),
		0o600,
	); err != nil {
		t.Fatalf("update GitHub config: %v", err)
	}
	secondIdentity, ok := githubConfigIdentityAt(homeDirectory)

	if !ok {
		t.Fatal("updated GitHub config identity is unavailable")
	}
	if firstIdentity == secondIdentity {
		t.Fatalf("GitHub config identity did not change: %#v", firstIdentity)
	}
}

// TestGitHubConfigIdentityAtRejectsSymlink は設定ファイルのsymlinkを拒否する。
func TestGitHubConfigIdentityAtRejectsSymlink(t *testing.T) {
	homeDirectory := secureTempDirectory(t)
	configDirectory := filepath.Join(homeDirectory, githubConfigDirectory)
	if err := os.MkdirAll(configDirectory, 0o700); err != nil {
		t.Fatalf("create GitHub config directory: %v", err)
	}
	targetPath := filepath.Join(homeDirectory, "target-hosts.yml")
	if err := os.WriteFile(targetPath, []byte("private"), 0o600); err != nil {
		t.Fatalf("write symlink target: %v", err)
	}
	if err := os.Symlink(
		targetPath,
		filepath.Join(configDirectory, githubHostsFileName),
	); err != nil {
		t.Fatalf("create GitHub config symlink: %v", err)
	}

	_, ok := githubConfigIdentityAt(homeDirectory)

	if ok {
		t.Fatal("symbolic-link GitHub config was accepted")
	}
}
