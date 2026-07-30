package githubrepos

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"
)

const (
	restrictedSystemPath = "/usr/bin:/bin:/usr/sbin:/sbin"
	processExitWait      = 500 * time.Millisecond
)

var githubCLIExecutableCandidates = []executableCandidate{
	{path: "/opt/homebrew/bin/gh", root: "/opt/homebrew"},
	{path: "/usr/local/bin/gh", root: "/usr/local"},
	{path: "/opt/local/bin/gh", root: "/opt/local"},
}

// CommandRunner は外部コマンド実行を差し替える境界を定義する。
type CommandRunner interface {
	FindExecutable(name string) (string, error)
	Run(ctx context.Context, command Command) CommandResult
}

// Command は制限付きで実行する外部コマンドを表現する。
type Command struct {
	Path        string
	Args        []string
	Timeout     time.Duration
	StdoutLimit int
	StderrLimit int
}

// CommandResult は外部コマンドの取得可能な結果を表現する。
type CommandResult struct {
	Stdout         []byte
	Stderr         []byte
	Err            error
	TimedOut       bool
	StdoutOverflow bool
	StderrOverflow bool
}

// ExecRunner は os/exec を使用して外部コマンドを実行する。
type ExecRunner struct{}

// NewExecRunner は実環境向けのコマンド実行機構を初期化する。
func NewExecRunner() ExecRunner {
	return ExecRunner{}
}

// FindExecutable は検証済みの標準的な配置先からGitHub CLIを検索する。
func (ExecRunner) FindExecutable(name string) (string, error) {
	if name != "gh" {
		return "", exec.ErrNotFound
	}

	for _, candidate := range githubCLIExecutableCandidates {
		sourcePath, err := resolveTrustedExecutable(candidate)
		if err == nil {
			return stageGitHubCLI(sourcePath)
		}
	}

	return "", exec.ErrNotFound
}

// Run は環境、実行時間、出力量を制限して外部コマンドを実行する。
func (ExecRunner) Run(parentContext context.Context, command Command) CommandResult {
	if err := validatePrivateExecutable(command.Path); err != nil {
		return CommandResult{Err: fmt.Errorf("validate executable: %w", err)}
	}
	environment, err := restrictedCommandEnvironment(command.Path, false)
	if err != nil {
		return CommandResult{Err: err}
	}

	return runBoundedCommand(parentContext, command, environment)
}

// runBoundedCommand は検証済みコマンドを時間・出力量・プロセスグループ制限付きで実行する。
func runBoundedCommand(
	parentContext context.Context,
	command Command,
	environment []string,
) CommandResult {
	ctx, cancel := context.WithTimeout(parentContext, command.Timeout)
	defer cancel()

	stdout := newLimitedBuffer(command.StdoutLimit, cancel)
	stderr := newLimitedBuffer(command.StderrLimit, cancel)
	process := exec.CommandContext(ctx, command.Path, command.Args...)
	configureRestrictedProcess(process, environment, true)
	process.Stdout = stdout
	process.Stderr = stderr

	err := process.Run()

	return CommandResult{
		Stdout:         stdout.Bytes(),
		Stderr:         stderr.Bytes(),
		Err:            err,
		TimedOut:       errors.Is(ctx.Err(), context.DeadlineExceeded),
		StdoutOverflow: stdout.Overflow(),
		StderrOverflow: stderr.Overflow(),
	}
}

// Login はTerminal上で環境を制限したGitHub CLIのWeb認証を実行する。
func (runner ExecRunner) Login(parentContext context.Context) error {
	githubCLIPath, err := runner.FindExecutable("gh")
	if err != nil {
		return err
	}
	environment, err := restrictedCommandEnvironment(githubCLIPath, true)
	if err != nil {
		return err
	}

	process := exec.CommandContext(
		parentContext,
		githubCLIPath,
		githubCLILoginArguments()...,
	)
	configureRestrictedProcess(process, environment, false)
	process.Stdin = os.Stdin
	process.Stdout = os.Stdout
	process.Stderr = os.Stderr

	return process.Run()
}

// githubCLILoginArguments はSSH鍵操作とclipboard書込を伴わないWeb認証引数を返す。
func githubCLILoginArguments() []string {
	return []string{
		"auth",
		"login",
		"--hostname",
		githubHostname,
		"--web",
		"--skip-ssh-key",
	}
}

// resolveTrustedExecutable は固定候補のリンク先と配置条件を検証する。
func resolveTrustedExecutable(candidate executableCandidate) (string, error) {
	if !filepath.IsAbs(candidate.path) || !filepath.IsAbs(candidate.root) {
		return "", fmt.Errorf("executable candidate is not absolute")
	}
	if err := validateExecutablePathComponents(candidate.path, true); err != nil {
		return "", err
	}

	resolvedPath, err := filepath.EvalSymlinks(candidate.path)
	if err != nil {
		return "", fmt.Errorf("resolve executable links: %w", err)
	}
	resolvedPath = filepath.Clean(resolvedPath)
	if !isPathInside(candidate.root, resolvedPath) {
		return "", fmt.Errorf("executable resolves outside trusted root")
	}
	if err := validateExecutableInRoot(candidate.root, resolvedPath); err != nil {
		return "", err
	}

	return resolvedPath, nil
}

// validateResolvedExecutable は実体が許可した配置先にある実行可能ファイルか検証する。
func validateResolvedExecutable(path string) error {
	path = filepath.Clean(path)
	if filepath.Base(path) != "gh" {
		return fmt.Errorf("executable path is not allowed")
	}
	for _, candidate := range githubCLIExecutableCandidates {
		if isPathInside(candidate.root, path) {
			return validateExecutableInRoot(candidate.root, path)
		}
	}

	return fmt.Errorf("executable path is not allowed")
}

// validateExecutableInRoot は指定ルート配下の実行ファイル実体を検証する。
func validateExecutableInRoot(root string, path string) error {
	if filepath.Base(path) != "gh" || !isPathInside(root, path) {
		return fmt.Errorf("executable path is not allowed")
	}
	if err := validateExecutablePathComponents(path, false); err != nil {
		return err
	}

	info, err := os.Lstat(path)
	if err != nil {
		return fmt.Errorf("inspect executable: %w", err)
	}
	if !info.Mode().IsRegular() || info.Mode().Perm()&0o111 == 0 {
		return fmt.Errorf("path is not an executable regular file")
	}
	ownerID, ok := fileOwnerID(info)
	if !ok || (ownerID != 0 && ownerID != uint32(os.Getuid())) {
		return fmt.Errorf("executable owner is not trusted")
	}
	if info.Mode().Perm()&0o022 != 0 {
		return fmt.Errorf("executable is writable by another account")
	}

	return nil
}

// validateExecutablePathComponents は実行ファイルまでの所有者と書込権限を検証する。
func validateExecutablePathComponents(path string, allowFinalSymlink bool) error {
	cleanPath := filepath.Clean(path)
	if !filepath.IsAbs(cleanPath) {
		return fmt.Errorf("executable path is not absolute")
	}

	currentPath := string(filepath.Separator)
	components := strings.Split(strings.TrimPrefix(cleanPath, string(filepath.Separator)), string(filepath.Separator))
	for index, component := range components {
		if component == "" {
			continue
		}

		currentPath = filepath.Join(currentPath, component)
		info, err := os.Lstat(currentPath)
		if err != nil {
			return fmt.Errorf("inspect executable path component %q: %w", currentPath, err)
		}
		isFinalComponent := index == len(components)-1
		ownerID, ok := fileOwnerID(info)
		if !ok || (ownerID != 0 && ownerID != uint32(os.Getuid())) {
			return fmt.Errorf("executable path owner is not trusted")
		}
		if info.Mode()&os.ModeSymlink != 0 {
			if allowFinalSymlink && isFinalComponent {
				continue
			}
			return fmt.Errorf("unexpected symbolic link in executable path")
		}

		if info.Mode().Perm()&0o002 != 0 {
			return fmt.Errorf("executable path is writable by any account")
		}
		if info.Mode().Perm()&0o020 != 0 && ownerID != uint32(os.Getuid()) {
			return fmt.Errorf("system-owned executable path is group-writable")
		}
		if !isFinalComponent && !info.IsDir() {
			return fmt.Errorf("executable path component is not a directory")
		}
	}

	return nil
}

// restrictedCommandEnvironment は親プロセスの認証情報や実行設定を継承しない環境を生成する。
func restrictedCommandEnvironment(executablePath string, interactive bool) ([]string, error) {
	homeDirectory, err := currentUserHomeDirectory()
	if err != nil {
		return nil, fmt.Errorf("resolve restricted command home: %w", err)
	}

	pathValue := filepath.Dir(executablePath) + string(os.PathListSeparator) + restrictedSystemPath
	environment := []string{
		"HOME=" + homeDirectory,
		"PATH=" + pathValue,
		"LC_ALL=C",
		"GH_PAGER=cat",
		"PAGER=cat",
		"NO_COLOR=1",
		"GH_NO_UPDATE_NOTIFIER=1",
	}
	if interactive {
		return append(
			environment,
			"GH_BROWSER=/usr/bin/open",
			"BROWSER=/usr/bin/open",
			"TERM=xterm-256color",
		), nil
	}

	return append(environment, "GH_PROMPT_DISABLED=1"), nil
}

// configureRestrictedProcess は子孫プロセスを含めて停止できる実行条件を設定する。
func configureRestrictedProcess(process *exec.Cmd, environment []string, isolateProcessGroup bool) {
	process.Env = environment
	process.WaitDelay = processExitWait
	if !isolateProcessGroup {
		return
	}

	process.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	process.Cancel = func() error {
		if process.Process == nil {
			return os.ErrProcessDone
		}

		err := syscall.Kill(-process.Process.Pid, syscall.SIGKILL)
		if errors.Is(err, syscall.ESRCH) {
			return os.ErrProcessDone
		}

		return err
	}
}

// isPathInside はパスが指定ルート自身または配下にあるか判定する。
func isPathInside(root string, path string) bool {
	relativePath, err := filepath.Rel(filepath.Clean(root), filepath.Clean(path))
	if err != nil {
		return false
	}

	return relativePath == "." ||
		(relativePath != ".." && !strings.HasPrefix(relativePath, ".."+string(filepath.Separator)))
}

type executableCandidate struct {
	path string
	root string
}

type limitedBuffer struct {
	buffer     bytes.Buffer
	limit      int
	overflow   bool
	cancel     context.CancelFunc
	cancelOnce sync.Once
	mutex      sync.Mutex
}

// newLimitedBuffer は保持するバイト数に上限がある出力先を初期化する。
func newLimitedBuffer(limit int, cancel context.CancelFunc) *limitedBuffer {
	return &limitedBuffer{
		limit:  limit,
		cancel: cancel,
	}
}

// Write は上限到達時に実行を中断し、保持データを制限する。
func (buffer *limitedBuffer) Write(value []byte) (int, error) {
	originalLength := len(value)

	buffer.mutex.Lock()
	remaining := max(buffer.limit-buffer.buffer.Len(), 0)
	if remaining > 0 {
		writeLength := min(remaining, originalLength)
		_, _ = buffer.buffer.Write(value[:writeLength])
	}
	overflowed := originalLength > remaining
	if overflowed {
		buffer.overflow = true
	}
	buffer.mutex.Unlock()

	if overflowed && buffer.cancel != nil {
		buffer.cancelOnce.Do(buffer.cancel)
	}

	return originalLength, nil
}

// Bytes は保持した出力の複製を返す。
func (buffer *limitedBuffer) Bytes() []byte {
	buffer.mutex.Lock()
	defer buffer.mutex.Unlock()

	return bytes.Clone(buffer.buffer.Bytes())
}

// Overflow は上限を超える出力があったか返す。
func (buffer *limitedBuffer) Overflow() bool {
	buffer.mutex.Lock()
	defer buffer.mutex.Unlock()

	return buffer.overflow
}
