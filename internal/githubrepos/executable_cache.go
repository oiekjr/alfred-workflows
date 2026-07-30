package githubrepos

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"syscall"
)

const (
	executableCacheDirectory = "executables"
	maximumExecutableBytes   = 256 * 1024 * 1024
	executableSnapshotName   = "gh"
	executableIdentityName   = "gh.source"
	maximumIdentityBytes     = 256
)

// stageGitHubCLI は検証済みのGitHub CLIを非公開領域へ複製して実行元を固定する。
func stageGitHubCLI(sourcePath string) (string, error) {
	cacheRoot, err := expectedAlfredCacheRoot()
	if err != nil {
		return "", fmt.Errorf("resolve executable cache: %w", err)
	}

	return stageGitHubCLIInCache(sourcePath, cacheRoot)
}

// stageGitHubCLIInCache は指定した非公開キャッシュへGitHub CLIを複製する。
func stageGitHubCLIInCache(sourcePath string, cacheRoot string) (string, error) {
	sourceFile, err := os.OpenFile(sourcePath, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return "", fmt.Errorf("open GitHub CLI source: %w", err)
	}
	defer sourceFile.Close()

	sourceInfo, err := sourceFile.Stat()
	if err != nil {
		return "", fmt.Errorf("inspect GitHub CLI source: %w", err)
	}
	if err := validateSourceExecutableInfo(sourceInfo); err != nil {
		return "", err
	}

	cacheDirectory, err := ensureSecureCacheSubdirectory(cacheRoot, executableCacheDirectory)
	if err != nil {
		return "", fmt.Errorf("prepare executable cache: %w", err)
	}

	sourceIdentity, err := executableSourceIdentity(sourceInfo)
	if err != nil {
		return "", err
	}
	snapshotPath := filepath.Join(cacheDirectory, executableSnapshotName)
	identityPath := filepath.Join(cacheDirectory, executableIdentityName)
	if err := validatePrivateExecutableInCache(snapshotPath, cacheRoot); err == nil {
		cachedIdentity, readErr := readPrivateFile(identityPath, maximumIdentityBytes)
		if readErr == nil && string(cachedIdentity) == sourceIdentity {
			return snapshotPath, nil
		}
	}

	err = writePrivateFileAtomically(
		cacheDirectory,
		executableSnapshotName,
		func(destination *os.File) error {
			copiedBytes, copyErr := io.Copy(destination, io.LimitReader(sourceFile, maximumExecutableBytes+1))
			if copyErr != nil {
				return fmt.Errorf("copy GitHub CLI: %w", copyErr)
			}
			if copiedBytes != sourceInfo.Size() || copiedBytes > maximumExecutableBytes {
				return fmt.Errorf("GitHub CLI changed or exceeded the size limit")
			}
			if chmodErr := destination.Chmod(0o500); chmodErr != nil {
				return fmt.Errorf("restrict GitHub CLI snapshot: %w", chmodErr)
			}

			return nil
		},
	)
	if err != nil {
		return "", err
	}
	if err := validatePrivateExecutableInCache(snapshotPath, cacheRoot); err != nil {
		return "", err
	}

	err = writePrivateFileAtomically(
		cacheDirectory,
		executableIdentityName,
		func(destination *os.File) error {
			if _, writeErr := destination.WriteString(sourceIdentity); writeErr != nil {
				return fmt.Errorf("write GitHub CLI identity: %w", writeErr)
			}

			return nil
		},
	)
	if err != nil {
		return "", err
	}

	return snapshotPath, nil
}

// validateSourceExecutableInfo は開いた実行ファイル自体の所有者と権限を検証する。
func validateSourceExecutableInfo(info os.FileInfo) error {
	if !info.Mode().IsRegular() || info.Mode().Perm()&0o111 == 0 {
		return fmt.Errorf("GitHub CLI source is not an executable regular file")
	}
	if info.Size() <= 0 || info.Size() > maximumExecutableBytes {
		return fmt.Errorf("GitHub CLI source size is unsupported")
	}

	ownerID, ok := fileOwnerID(info)
	if !ok || (ownerID != 0 && ownerID != uint32(os.Getuid())) {
		return fmt.Errorf("GitHub CLI source owner is not trusted")
	}
	if info.Mode().Perm()&0o022 != 0 {
		return fmt.Errorf("GitHub CLI source is writable by another account")
	}

	return nil
}

// executableSourceIdentity は差替えを識別できるファイル属性を生成する。
func executableSourceIdentity(info os.FileInfo) (string, error) {
	status, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return "", fmt.Errorf("GitHub CLI source identity is unavailable")
	}

	return fmt.Sprintf(
		"%x:%x:%x:%x",
		uint64(status.Dev),
		status.Ino,
		uint64(info.Size()),
		uint64(info.ModTime().UnixNano()),
	), nil
}

// validatePrivateExecutable は専用キャッシュ内の読取・実行専用ファイルか検証する。
func validatePrivateExecutable(path string) error {
	cacheRoot, err := expectedAlfredCacheRoot()
	if err != nil {
		return err
	}

	return validatePrivateExecutableInCache(path, cacheRoot)
}

// validatePrivateExecutableInCache は指定した専用キャッシュ内の実行ファイルを検証する。
func validatePrivateExecutableInCache(path string, cacheRoot string) error {
	expectedDirectory := filepath.Join(cacheRoot, executableCacheDirectory)
	if filepath.Dir(filepath.Clean(path)) != expectedDirectory ||
		filepath.Base(path) != executableSnapshotName {
		return fmt.Errorf("executable snapshot is outside the private cache")
	}

	info, err := validatePrivateRegularFile(path)
	if err != nil {
		return err
	}
	if info.Mode().Perm() != 0o500 {
		return fmt.Errorf("executable snapshot permissions are invalid")
	}

	return nil
}
