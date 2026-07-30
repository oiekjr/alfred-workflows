package githubrepos

import (
	"bytes"
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// TestLimitedBufferKeepsBoundedOutputは保持データが上限内に収まることを検証する。
func TestLimitedBufferKeepsBoundedOutput(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	buffer := newLimitedBuffer(4, cancel)

	written, err := buffer.Write([]byte("abcdef"))

	if err != nil {
		t.Fatalf("write: %v", err)
	}
	if written != 6 {
		t.Errorf("written = %d, want 6", written)
	}
	if !bytes.Equal(buffer.Bytes(), []byte("abcd")) {
		t.Errorf("bytes = %q, want %q", buffer.Bytes(), "abcd")
	}
	if !buffer.Overflow() {
		t.Error("overflow = false, want true")
	}
	if ctx.Err() != context.Canceled {
		t.Errorf("context error = %v, want canceled", ctx.Err())
	}
}

// TestRunBoundedCommandStopsProcessOnOverflow は出力超過時にタイムアウト前に停止する。
func TestRunBoundedCommandStopsProcessOnOverflow(t *testing.T) {
	environment, err := restrictedCommandEnvironment("/bin/sh", false)
	if err != nil {
		t.Fatalf("create restricted environment: %v", err)
	}
	startedAt := time.Now()

	result := runBoundedCommand(context.Background(), Command{
		Path:        "/bin/sh",
		Args:        []string{"-c", "/usr/bin/yes"},
		Timeout:     5 * time.Second,
		StdoutLimit: 64,
		StderrLimit: 64,
	}, environment)

	if !result.StdoutOverflow {
		t.Fatal("stdout overflow = false, want true")
	}
	if result.TimedOut {
		t.Fatal("timed out = true, want overflow cancellation")
	}
	if result.Err == nil {
		t.Fatal("command error = nil, want cancellation error")
	}
	if len(result.Stdout) != 64 {
		t.Errorf("stdout bytes = %d, want 64", len(result.Stdout))
	}
	if time.Since(startedAt) >= 2*time.Second {
		t.Errorf("overflow cancellation took %s", time.Since(startedAt))
	}
}

// TestResolveTrustedExecutableAcceptsLinkInsideRoot は許可ルート内のsymlinkを検証する。
func TestResolveTrustedExecutableAcceptsLinkInsideRoot(t *testing.T) {
	rootDirectory := secureTempDirectory(t)
	executablePath := filepath.Join(rootDirectory, "Cellar", "gh", "1.0.0", "bin", "gh")
	if err := os.MkdirAll(filepath.Dir(executablePath), 0o755); err != nil {
		t.Fatalf("create executable directory: %v", err)
	}
	if err := os.WriteFile(executablePath, []byte("#!/bin/sh\n"), 0o555); err != nil {
		t.Fatalf("write executable: %v", err)
	}
	linkDirectory := filepath.Join(rootDirectory, "bin")
	if err := os.Mkdir(linkDirectory, 0o755); err != nil {
		t.Fatalf("create link directory: %v", err)
	}
	linkPath := filepath.Join(linkDirectory, "gh")
	if err := os.Symlink(filepath.Join("..", "Cellar", "gh", "1.0.0", "bin", "gh"), linkPath); err != nil {
		t.Fatalf("create executable link: %v", err)
	}

	resolvedPath, err := resolveTrustedExecutable(executableCandidate{
		path: linkPath,
		root: rootDirectory,
	})

	if err != nil {
		t.Fatalf("resolve executable: %v", err)
	}
	if resolvedPath != executablePath {
		t.Errorf("resolved path = %q, want %q", resolvedPath, executablePath)
	}
}

// TestResolveInstalledGitHubCLI は実環境に標準配置がある場合の検証を行う。
func TestResolveInstalledGitHubCLI(t *testing.T) {
	for _, candidate := range githubCLIExecutableCandidates {
		if _, err := os.Lstat(candidate.path); err == nil {
			path, resolveErr := resolveTrustedExecutable(candidate)
			if resolveErr != nil {
				t.Fatalf("resolve installed GitHub CLI: %v", resolveErr)
			}
			if err := validateExecutableInRoot(candidate.root, path); err != nil {
				t.Fatalf("validate installed GitHub CLI: %v", err)
			}
			snapshotPath, stageErr := stageGitHubCLIInCache(path, secureTempDirectory(t))
			if stageErr != nil {
				t.Fatalf("stage installed GitHub CLI: %v", stageErr)
			}
			process := exec.Command(snapshotPath, "--version")
			environment, environmentErr := restrictedCommandEnvironment(snapshotPath, false)
			if environmentErr != nil {
				t.Fatalf("create installed GitHub CLI environment: %v", environmentErr)
			}
			process.Env = environment
			output, runErr := process.Output()
			if runErr != nil {
				t.Fatalf("run installed GitHub CLI snapshot: %v", runErr)
			}
			if !strings.HasPrefix(string(output), "gh version ") {
				t.Fatalf("GitHub CLI version output = %q", output)
			}

			return
		}
	}

	t.Skip("GitHub CLI is not installed in a supported location")
}

// TestResolveTrustedExecutableRejectsLinkOutsideRoot は許可ルート外へのsymlinkを拒否する。
func TestResolveTrustedExecutableRejectsLinkOutsideRoot(t *testing.T) {
	rootDirectory := secureTempDirectory(t)
	outsideDirectory := secureTempDirectory(t)
	executablePath := filepath.Join(outsideDirectory, "gh")
	if err := os.WriteFile(executablePath, []byte("#!/bin/sh\n"), 0o555); err != nil {
		t.Fatalf("write executable: %v", err)
	}
	linkDirectory := filepath.Join(rootDirectory, "bin")
	if err := os.Mkdir(linkDirectory, 0o755); err != nil {
		t.Fatalf("create link directory: %v", err)
	}
	linkPath := filepath.Join(linkDirectory, "gh")
	if err := os.Symlink(executablePath, linkPath); err != nil {
		t.Fatalf("create executable link: %v", err)
	}

	_, err := resolveTrustedExecutable(executableCandidate{
		path: linkPath,
		root: rootDirectory,
	})

	if err == nil {
		t.Fatal("resolve executable succeeded, want error")
	}
}

// TestStageGitHubCLIUsesPrivateSnapshot は共有書込可能な導入元を直接実行しないことを検証する。
func TestStageGitHubCLIUsesPrivateSnapshot(t *testing.T) {
	sourceRoot := secureTempDirectory(t)
	sourceDirectory := filepath.Join(sourceRoot, "Cellar", "gh", "1.0.0", "bin")
	if err := os.MkdirAll(sourceDirectory, 0o755); err != nil {
		t.Fatalf("create source directory: %v", err)
	}
	if err := os.Chmod(filepath.Join(sourceRoot, "Cellar"), 0o770); err != nil {
		t.Fatalf("make source parent group-writable: %v", err)
	}
	sourcePath := filepath.Join(sourceDirectory, "gh")
	sourceData := []byte("#!/bin/sh\nexit 0\n")
	if err := os.WriteFile(sourcePath, sourceData, 0o555); err != nil {
		t.Fatalf("write source executable: %v", err)
	}
	cacheRoot := secureTempDirectory(t)

	snapshotPath, err := stageGitHubCLIInCache(sourcePath, cacheRoot)

	if err != nil {
		t.Fatalf("stage GitHub CLI: %v", err)
	}
	if filepath.Dir(snapshotPath) != filepath.Join(cacheRoot, executableCacheDirectory) {
		t.Errorf("snapshot path = %q, want private executable cache", snapshotPath)
	}
	if filepath.Base(snapshotPath) != executableSnapshotName {
		t.Errorf("snapshot name = %q, want %q", filepath.Base(snapshotPath), executableSnapshotName)
	}
	if err := validatePrivateExecutableInCache(snapshotPath, cacheRoot); err != nil {
		t.Fatalf("validate snapshot: %v", err)
	}
	snapshotData, err := os.ReadFile(snapshotPath)
	if err != nil {
		t.Fatalf("read snapshot: %v", err)
	}
	if !bytes.Equal(snapshotData, sourceData) {
		t.Errorf("snapshot data = %q, want %q", snapshotData, sourceData)
	}

	reusedPath, err := stageGitHubCLIInCache(sourcePath, cacheRoot)
	if err != nil {
		t.Fatalf("reuse GitHub CLI snapshot: %v", err)
	}
	if reusedPath != snapshotPath {
		t.Errorf("reused path = %q, want %q", reusedPath, snapshotPath)
	}
}

// TestStageGitHubCLIRejectsWritableSource は共有書込可能な実行ファイルを拒否する。
func TestStageGitHubCLIRejectsWritableSource(t *testing.T) {
	sourceRoot := secureTempDirectory(t)
	sourcePath := filepath.Join(sourceRoot, "gh")
	if err := os.WriteFile(sourcePath, []byte("#!/bin/sh\n"), 0o555); err != nil {
		t.Fatalf("write source executable: %v", err)
	}
	if err := os.Chmod(sourcePath, 0o775); err != nil {
		t.Fatalf("make source executable group-writable: %v", err)
	}

	_, err := stageGitHubCLIInCache(sourcePath, secureTempDirectory(t))

	if err == nil {
		t.Fatal("stage GitHub CLI succeeded, want error")
	}
}

// TestRestrictedCommandEnvironmentDropsParentSecrets は親環境の認証情報を継承しないことを検証する。
func TestRestrictedCommandEnvironmentDropsParentSecrets(t *testing.T) {
	t.Setenv("GH_TOKEN", "secret-token")
	t.Setenv("GH_CONFIG_DIR", "/tmp/untrusted-gh-config")
	t.Setenv("HTTPS_PROXY", "http://127.0.0.1:8080")
	t.Setenv("BROWSER", "/tmp/untrusted-browser")

	environment, err := restrictedCommandEnvironment("/opt/homebrew/bin/gh", false)

	if err != nil {
		t.Fatalf("create restricted environment: %v", err)
	}
	joinedEnvironment := strings.Join(environment, "\n")
	for _, forbiddenValue := range []string{
		"secret-token",
		"GH_CONFIG_DIR=",
		"HTTPS_PROXY=",
		"BROWSER=",
		"/tmp/untrusted-browser",
	} {
		if strings.Contains(joinedEnvironment, forbiddenValue) {
			t.Errorf("environment contains %q: %s", forbiddenValue, joinedEnvironment)
		}
	}
	if !strings.Contains(joinedEnvironment, "GH_PROMPT_DISABLED=1") {
		t.Errorf("environment does not disable prompts: %s", joinedEnvironment)
	}
}

// TestRestrictedInteractiveEnvironmentUsesSystemBrowser は認証時のbrowserを固定する。
func TestRestrictedInteractiveEnvironmentUsesSystemBrowser(t *testing.T) {
	environment, err := restrictedCommandEnvironment("/opt/homebrew/bin/gh", true)

	if err != nil {
		t.Fatalf("create restricted environment: %v", err)
	}
	joinedEnvironment := strings.Join(environment, "\n")
	if !strings.Contains(joinedEnvironment, "GH_BROWSER=/usr/bin/open") ||
		!strings.Contains(joinedEnvironment, "BROWSER=/usr/bin/open") {
		t.Errorf("environment does not fix browser: %s", joinedEnvironment)
	}
	if strings.Contains(joinedEnvironment, "GH_PROMPT_DISABLED=") {
		t.Errorf("interactive environment disables prompts: %s", joinedEnvironment)
	}
}

// TestGitHubCLILoginArgumentsAvoidSensitiveSideEffects は認証導線の副作用を制限する。
func TestGitHubCLILoginArgumentsAvoidSensitiveSideEffects(t *testing.T) {
	arguments := githubCLILoginArguments()
	joinedArguments := strings.Join(arguments, " ")

	for _, forbiddenArgument := range []string{
		"--clipboard",
		"--with-token",
		"--insecure-storage",
	} {
		if strings.Contains(joinedArguments, forbiddenArgument) {
			t.Errorf("login arguments contain %q: %s", forbiddenArgument, joinedArguments)
		}
	}
	if !strings.Contains(joinedArguments, "--web") ||
		!strings.Contains(joinedArguments, "--skip-ssh-key") {
		t.Errorf("login arguments do not constrain authentication: %s", joinedArguments)
	}
}
