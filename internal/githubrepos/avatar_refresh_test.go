package githubrepos

import (
	"strings"
	"testing"
)

// TestBackgroundHelperInvocationRequiresFixedArguments は検索入力から内部処理へ到達できないことを検証する。
func TestBackgroundHelperInvocationRequiresFixedArguments(t *testing.T) {
	testCases := []struct {
		name      string
		arguments []string
		want      bool
	}{
		{
			name: "fixed helper invocation",
			arguments: []string{
				"github-repositories",
				"--background-helper",
				"refresh-avatars",
			},
			want: true,
		},
		{
			name: "Alfred query is one argument",
			arguments: []string{
				"github-repositories",
				"--background-helper refresh-avatars",
			},
		},
		{
			name: "unknown helper action",
			arguments: []string{
				"github-repositories",
				"--background-helper",
				"unknown",
			},
		},
		{
			name: "additional untrusted argument",
			arguments: []string{
				"github-repositories",
				"--background-helper",
				"refresh-avatars",
				"untrusted",
			},
		},
	}

	for _, testCase := range testCases {
		t.Run(testCase.name, func(t *testing.T) {
			got := IsBackgroundHelperInvocation(testCase.arguments)

			if got != testCase.want {
				t.Fatalf("IsBackgroundHelperInvocation() = %t, want %t", got, testCase.want)
			}
		})
	}
}

// TestRestrictedBackgroundEnvironmentDropsParentSecrets は非同期処理の環境を検証する。
func TestRestrictedBackgroundEnvironmentDropsParentSecrets(t *testing.T) {
	t.Setenv("GH_TOKEN", "secret-token")
	t.Setenv("GH_CONFIG_DIR", "/tmp/untrusted-gh-config")
	t.Setenv("HTTPS_PROXY", "http://127.0.0.1:8080")
	t.Setenv("BROWSER", "/tmp/untrusted-browser")

	environment, err := restrictedBackgroundHelperEnvironment()

	if err != nil {
		t.Fatalf("create background helper environment: %v", err)
	}
	joinedEnvironment := strings.Join(environment, "\n")
	for _, forbiddenValue := range []string{
		"secret-token",
		"GH_TOKEN=",
		"GH_CONFIG_DIR=",
		"HTTPS_PROXY=",
		"BROWSER=",
		"/tmp/untrusted-browser",
	} {
		if strings.Contains(joinedEnvironment, forbiddenValue) {
			t.Errorf("background environment contains %q: %s", forbiddenValue, joinedEnvironment)
		}
	}
	for _, requiredValue := range []string{
		"HOME=",
		"PATH=" + restrictedSystemPath,
		"LC_ALL=C",
		"alfred_workflow_cache=",
	} {
		if !strings.Contains(joinedEnvironment, requiredValue) {
			t.Errorf("background environment does not contain %q: %s", requiredValue, joinedEnvironment)
		}
	}
}

// TestAvatarRefreshLockPreventsConcurrentWorkers はアバター更新の多重起動を防ぐ。
func TestAvatarRefreshLockPreventsConcurrentWorkers(t *testing.T) {
	rootDirectory := secureTempDirectory(t)
	firstLock, acquired, err := acquireAvatarRefreshLock(rootDirectory)
	if err != nil || !acquired {
		t.Fatalf("acquire first lock = %t, %v", acquired, err)
	}
	defer releaseAvatarRefreshLock(firstLock)

	secondLock, secondAcquired, err := acquireAvatarRefreshLock(rootDirectory)
	if err != nil {
		t.Fatalf("acquire second lock: %v", err)
	}
	if secondAcquired || secondLock != nil {
		t.Fatalf("second lock = %#v, %t; want unavailable", secondLock, secondAcquired)
	}
}
