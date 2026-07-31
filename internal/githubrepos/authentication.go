package githubrepos

import (
	"path/filepath"
	"strings"
	"syscall"
)

const (
	githubConfigDirectory = ".config/gh"
	githubHostsFileName   = "hosts.yml"
)

type authenticationStatus struct {
	Hostname string
	Login    string
	Scopes   string
}

type githubConfigIdentity struct {
	Device               uint64 `json:"device"`
	Inode                uint64 `json:"inode"`
	Size                 int64  `json:"size"`
	ModificationUnixNano int64  `json:"modification_unix_nano"`
}

type githubAccountIdentity struct {
	Hostname string               `json:"hostname"`
	Login    string               `json:"login"`
	Config   githubConfigIdentity `json:"config"`
}

// githubConfigProvider はGitHub CLI設定ファイルの非秘密な同一性情報を提供する。
type githubConfigProvider interface {
	CurrentIdentity() (githubConfigIdentity, bool)
}

type environmentGitHubConfigProvider struct{}

// CurrentIdentity はAlfred実行時の標準GitHub CLI設定ファイルを検証する。
func (environmentGitHubConfigProvider) CurrentIdentity() (githubConfigIdentity, bool) {
	if trustedAlfredCacheRootFromEnvironment() == "" {
		return githubConfigIdentity{}, false
	}

	homeDirectory, err := currentUserHomeDirectory()
	if err != nil {
		return githubConfigIdentity{}, false
	}

	return githubConfigIdentityAt(homeDirectory)
}

// githubConfigIdentityAt は標準hosts.ymlの内容を読まずにファイル同一性を取得する。
func githubConfigIdentityAt(homeDirectory string) (githubConfigIdentity, bool) {
	if !filepath.IsAbs(homeDirectory) {
		return githubConfigIdentity{}, false
	}

	path := filepath.Join(
		homeDirectory,
		githubConfigDirectory,
		githubHostsFileName,
	)
	info, err := validatePrivateRegularFile(path)
	if err != nil {
		return githubConfigIdentity{}, false
	}
	status, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return githubConfigIdentity{}, false
	}

	identity := githubConfigIdentity{
		Device:               uint64(status.Dev),
		Inode:                uint64(status.Ino),
		Size:                 info.Size(),
		ModificationUnixNano: info.ModTime().UnixNano(),
	}
	if !identity.valid() {
		return githubConfigIdentity{}, false
	}

	return identity, true
}

// valid はGitHub CLI設定ファイルの同一性情報が比較可能か検証する。
func (identity githubConfigIdentity) valid() bool {
	return identity.Inode > 0 &&
		identity.Size >= 0 &&
		identity.ModificationUnixNano > 0
}

// valid はキャッシュを所有するGitHubアカウント情報を検証する。
func (identity githubAccountIdentity) valid() bool {
	return identity.Hostname == githubHostname &&
		isGitHubLogin(identity.Login) &&
		identity.Config.valid()
}

// parseAuthenticationStatus は固定ロケールのgh auth status出力から非秘密情報を抽出する。
func parseAuthenticationStatus(output []byte) (authenticationStatus, bool) {
	const loginMarker = "Logged in to " + githubHostname + " account "
	const tokenSourceMarker = " ("
	const activeMarker = "Active account:"
	const scopesMarker = "Token scopes:"

	login := ""
	scopes := ""
	activeFound := false
	scopesFound := false
	for _, line := range strings.Split(string(output), "\n") {
		if loginStart := strings.Index(line, loginMarker); loginStart >= 0 {
			value := line[loginStart+len(loginMarker):]
			sourceStart := strings.Index(value, tokenSourceMarker)
			if sourceStart <= 0 || login != "" {
				return authenticationStatus{}, false
			}
			candidate := value[:sourceStart]
			if !isGitHubLogin(candidate) {
				return authenticationStatus{}, false
			}
			login = strings.ToLower(candidate)
		}

		if activeStart := strings.Index(line, activeMarker); activeStart >= 0 {
			if activeFound ||
				strings.TrimSpace(line[activeStart+len(activeMarker):]) != "true" {
				return authenticationStatus{}, false
			}
			activeFound = true
		}

		if scopesStart := strings.Index(line, scopesMarker); scopesStart >= 0 {
			if scopesFound {
				return authenticationStatus{}, false
			}
			scopes = strings.TrimSpace(line[scopesStart+len(scopesMarker):])
			scopesFound = true
		}
	}
	if login == "" || !activeFound {
		return authenticationStatus{}, false
	}

	return authenticationStatus{
		Hostname: githubHostname,
		Login:    login,
		Scopes:   scopes,
	}, true
}
