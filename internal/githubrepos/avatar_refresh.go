package githubrepos

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"time"
)

const (
	backgroundHelperMarker    = "--background-helper"
	avatarRefreshHelperAction = "refresh-avatars"
	backgroundCacheDirectory  = "background"
	avatarRefreshLockName     = "avatar-refresh.lock"
)

// StartAvatarRefreshHelper は固定引数のアバター更新処理を独立プロセスで開始する。
func StartAvatarRefreshHelper() error {
	executablePath, err := currentWorkflowExecutablePath()
	if err != nil {
		return err
	}
	environment, err := restrictedBackgroundHelperEnvironment()
	if err != nil {
		return err
	}

	nullDevice, err := os.OpenFile(os.DevNull, os.O_RDWR, 0)
	if err != nil {
		return fmt.Errorf("open null device: %w", err)
	}
	defer nullDevice.Close()

	process := exec.Command(
		executablePath,
		backgroundHelperMarker,
		avatarRefreshHelperAction,
	)
	process.Env = environment
	process.Stdin = nullDevice
	process.Stdout = nullDevice
	process.Stderr = nullDevice
	process.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := process.Start(); err != nil {
		return fmt.Errorf("start avatar refresh helper: %w", err)
	}
	if err := process.Process.Release(); err != nil {
		return fmt.Errorf("release avatar refresh helper: %w", err)
	}

	return nil
}

// RefreshCachedAvatars は短期キャッシュに含まれる所有者画像を更新する。
func RefreshCachedAvatars(ctx context.Context) error {
	rootDirectory := trustedAlfredCacheRootFromEnvironment()
	if rootDirectory == "" {
		return nil
	}

	lock, acquired, err := acquireAvatarRefreshLock(rootDirectory)
	if err != nil || !acquired {
		return err
	}
	defer releaseAvatarRefreshLock(lock)

	configIdentity, ok := (environmentGitHubConfigProvider{}).CurrentIdentity()
	if !ok {
		return nil
	}
	lists := newListCache(rootDirectory, time.Now)
	owners := make([]githubOwner, 0)
	if repositories, ok := lists.LoadRepositories(configIdentity); ok {
		owners = append(owners, repositoryOwners(repositories)...)
	}
	if projects, ok := lists.LoadProjects(configIdentity); ok {
		owners = append(owners, projectOwners(projects)...)
	}
	if len(owners) == 0 {
		return nil
	}

	return newAvatarCache(rootDirectory, newAvatarHTTPClient()).Refresh(ctx, owners)
}

// IsBackgroundHelperInvocation は固定された内部ヘルパー呼び出しか判定する。
func IsBackgroundHelperInvocation(arguments []string) bool {
	return len(arguments) == 3 &&
		arguments[1] == backgroundHelperMarker &&
		arguments[2] == avatarRefreshHelperAction
}

// restrictedBackgroundHelperEnvironment は親の秘密情報を継承しない実行環境を返す。
func restrictedBackgroundHelperEnvironment() ([]string, error) {
	homeDirectory, err := currentUserHomeDirectory()
	if err != nil {
		return nil, err
	}
	cacheRoot, err := expectedAlfredCacheRoot()
	if err != nil {
		return nil, err
	}

	return []string{
		"HOME=" + homeDirectory,
		"PATH=" + restrictedSystemPath,
		"LC_ALL=C",
		"alfred_workflow_cache=" + cacheRoot,
	}, nil
}

// acquireAvatarRefreshLock は多重更新を防ぐ非公開の排他ロックを取得する。
func acquireAvatarRefreshLock(rootDirectory string) (*os.File, bool, error) {
	directory, err := ensureSecureCacheSubdirectory(
		rootDirectory,
		backgroundCacheDirectory,
	)
	if err != nil {
		return nil, false, err
	}

	path := filepath.Join(directory, avatarRefreshLockName)
	lock, err := os.OpenFile(
		path,
		os.O_CREATE|os.O_RDWR|syscall.O_NOFOLLOW,
		0o600,
	)
	if err != nil {
		return nil, false, fmt.Errorf("open avatar refresh lock: %w", err)
	}
	if err := lock.Chmod(0o600); err != nil {
		_ = lock.Close()
		return nil, false, fmt.Errorf("restrict avatar refresh lock: %w", err)
	}
	if _, err := validatePrivateRegularFile(path); err != nil {
		_ = lock.Close()
		return nil, false, err
	}

	err = syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
	if errors.Is(err, syscall.EWOULDBLOCK) {
		_ = lock.Close()
		return nil, false, nil
	}
	if err != nil {
		_ = lock.Close()
		return nil, false, fmt.Errorf("lock avatar refresh: %w", err)
	}

	return lock, true, nil
}

// releaseAvatarRefreshLock はアバター更新の排他ロックを解放する。
func releaseAvatarRefreshLock(lock *os.File) {
	if lock == nil {
		return
	}

	_ = syscall.Flock(int(lock.Fd()), syscall.LOCK_UN)
	_ = lock.Close()
}
