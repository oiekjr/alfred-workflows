package githubrepos

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"syscall"
)

// trustedAlfredCacheRootFromEnvironment は期待したAlfredキャッシュパスだけを許可する。
func trustedAlfredCacheRootFromEnvironment() string {
	expectedPath, err := expectedAlfredCacheRoot()
	if err != nil {
		return ""
	}
	configuredPath := filepath.Clean(os.Getenv("alfred_workflow_cache"))
	if configuredPath != expectedPath {
		return ""
	}

	return expectedPath
}

// expectedAlfredCacheRoot は信頼できるホームディレクトリから専用キャッシュパスを生成する。
func expectedAlfredCacheRoot() (string, error) {
	homeDirectory, err := currentUserHomeDirectory()
	if err != nil {
		return "", err
	}

	expectedPath := filepath.Join(
		homeDirectory,
		"Library",
		"Caches",
		"com.runningwithcrayons.Alfred",
		"Workflow Data",
		workflowBundleIdentifier,
	)

	return expectedPath, nil
}

// ensureSecureCacheRoot は信頼済み親ディレクトリ内にキャッシュルートを用意する。
func ensureSecureCacheRoot(rootDirectory string) error {
	if rootDirectory == "" || !filepath.IsAbs(rootDirectory) {
		return fmt.Errorf("cache root is unavailable")
	}

	info, err := os.Lstat(rootDirectory)
	if err == nil {
		if !info.IsDir() {
			return fmt.Errorf("cache root is not a directory")
		}
		return validatePrivateDirectory(rootDirectory)
	}
	if !os.IsNotExist(err) {
		return fmt.Errorf("inspect cache root: %w", err)
	}

	parentDirectory := filepath.Dir(rootDirectory)
	if err := validateSecureDirectory(parentDirectory); err != nil {
		return fmt.Errorf("validate cache parent: %w", err)
	}
	if err := os.Mkdir(rootDirectory, 0o700); err != nil && !os.IsExist(err) {
		return fmt.Errorf("create cache root: %w", err)
	}

	return validatePrivateDirectory(rootDirectory)
}

// ensureSecureCacheSubdirectory はsymlinkを許可せず専用サブディレクトリを用意する。
func ensureSecureCacheSubdirectory(rootDirectory string, name string) (string, error) {
	if filepath.Base(name) != name || name == "." || name == "" {
		return "", fmt.Errorf("cache directory name is invalid")
	}
	if err := ensureSecureCacheRoot(rootDirectory); err != nil {
		return "", err
	}

	directory := filepath.Join(rootDirectory, name)
	info, err := os.Lstat(directory)
	if os.IsNotExist(err) {
		if err := os.Mkdir(directory, 0o700); err != nil && !os.IsExist(err) {
			return "", fmt.Errorf("create cache directory: %w", err)
		}
	} else if err != nil {
		return "", fmt.Errorf("inspect cache directory: %w", err)
	} else if !info.IsDir() {
		return "", fmt.Errorf("cache path is not a directory")
	}

	if err := validatePrivateDirectory(directory); err != nil {
		return "", err
	}

	return directory, nil
}

// readPrivateFile はsymlinkを追従せず容量制限付きで非公開ファイルを読み取る。
func readPrivateFile(path string, maximumBytes int64) ([]byte, error) {
	expectedInfo, err := validatePrivateRegularFile(path)
	if err != nil {
		return nil, err
	}
	if expectedInfo.Size() < 0 || expectedInfo.Size() > maximumBytes {
		return nil, fmt.Errorf("private file exceeds size limit")
	}

	file, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return nil, fmt.Errorf("open private file: %w", err)
	}
	defer file.Close()

	openedInfo, err := file.Stat()
	if err != nil {
		return nil, fmt.Errorf("inspect opened private file: %w", err)
	}
	if !os.SameFile(expectedInfo, openedInfo) {
		return nil, fmt.Errorf("private file changed during validation")
	}

	data, err := io.ReadAll(io.LimitReader(file, maximumBytes+1))
	if err != nil {
		return nil, fmt.Errorf("read private file: %w", err)
	}
	if int64(len(data)) > maximumBytes {
		return nil, fmt.Errorf("private file exceeds size limit")
	}

	return data, nil
}

// writePrivateFileAtomically は検証済みディレクトリへ0600のファイルを置換保存する。
func writePrivateFileAtomically(
	directory string,
	name string,
	write func(file *os.File) error,
) error {
	if filepath.Base(name) != name || name == "." || name == "" {
		return fmt.Errorf("private file name is invalid")
	}
	if err := validatePrivateDirectory(directory); err != nil {
		return err
	}

	temporaryFile, err := os.CreateTemp(directory, ".private-*.tmp")
	if err != nil {
		return fmt.Errorf("create private temporary file: %w", err)
	}
	temporaryPath := temporaryFile.Name()
	defer os.Remove(temporaryPath)

	if err := temporaryFile.Chmod(0o600); err != nil {
		_ = temporaryFile.Close()
		return fmt.Errorf("set private file permissions: %w", err)
	}
	if err := write(temporaryFile); err != nil {
		_ = temporaryFile.Close()
		return err
	}
	if err := temporaryFile.Sync(); err != nil {
		_ = temporaryFile.Close()
		return fmt.Errorf("sync private file: %w", err)
	}
	if err := temporaryFile.Close(); err != nil {
		return fmt.Errorf("close private file: %w", err)
	}

	destinationPath := filepath.Join(directory, name)
	if _, err := os.Lstat(destinationPath); err == nil {
		if _, err := validatePrivateRegularFile(destinationPath); err != nil {
			return fmt.Errorf("validate existing private file: %w", err)
		}
	} else if !os.IsNotExist(err) {
		return fmt.Errorf("inspect existing private file: %w", err)
	}

	if err := os.Rename(temporaryPath, destinationPath); err != nil {
		return fmt.Errorf("replace private file: %w", err)
	}
	if _, err := validatePrivateRegularFile(destinationPath); err != nil {
		return fmt.Errorf("validate replaced private file: %w", err)
	}

	return nil
}
