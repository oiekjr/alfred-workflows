package githubrepos

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"syscall"
)

const workflowBundleIdentifier = "com.oiekjr.alfred.github-repositories"

// currentUserHomeDirectory は実UIDとmacOS標準配置からホームディレクトリを検証する。
func currentUserHomeDirectory() (string, error) {
	homeDirectory, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("resolve home directory: %w", err)
	}
	homeDirectory = filepath.Clean(homeDirectory)
	if !filepath.IsAbs(homeDirectory) {
		return "", fmt.Errorf("home directory is not absolute")
	}

	userID := os.Getuid()
	if userID == 0 {
		if homeDirectory != "/var/root" && homeDirectory != "/private/var/root" {
			return "", fmt.Errorf("root home directory is outside the expected location")
		}
	} else if filepath.Dir(homeDirectory) != "/Users" ||
		filepath.Base(homeDirectory) == "." ||
		filepath.Base(homeDirectory) == "Shared" {
		return "", fmt.Errorf("home directory is outside /Users")
	}
	if err := validateSecureDirectory(homeDirectory); err != nil {
		return "", fmt.Errorf("validate home directory: %w", err)
	}
	info, err := os.Lstat(homeDirectory)
	if err != nil {
		return "", fmt.Errorf("inspect home directory: %w", err)
	}
	ownerID, ok := fileOwnerID(info)
	if !ok || ownerID != uint32(userID) {
		return "", fmt.Errorf("home directory owner does not match process owner")
	}

	return homeDirectory, nil
}

// validateSecureDirectory はパス全体が信頼できる所有者の非書込可能ディレクトリか検証する。
func validateSecureDirectory(path string) error {
	if err := validateSecurePathComponents(path); err != nil {
		return err
	}

	info, err := os.Lstat(path)
	if err != nil {
		return fmt.Errorf("inspect directory: %w", err)
	}
	if !info.IsDir() {
		return fmt.Errorf("path is not a directory")
	}

	return nil
}

// validatePrivateDirectory は現在のユーザー以外へアクセス権を与えないディレクトリか検証する。
func validatePrivateDirectory(path string) error {
	if err := validateSecureDirectory(path); err != nil {
		return err
	}

	info, err := os.Lstat(path)
	if err != nil {
		return fmt.Errorf("inspect private directory: %w", err)
	}
	ownerID, ok := fileOwnerID(info)
	if !ok || ownerID != uint32(os.Getuid()) {
		return fmt.Errorf("private directory owner is not trusted")
	}
	if info.Mode().Perm()&0o077 != 0 {
		return fmt.Errorf("private directory permissions are too broad")
	}

	return nil
}

// validatePrivateRegularFile は現在のユーザーだけがアクセスできる通常ファイルか検証する。
func validatePrivateRegularFile(path string) (os.FileInfo, error) {
	if err := validateSecurePathComponents(path); err != nil {
		return nil, err
	}

	info, err := os.Lstat(path)
	if err != nil {
		return nil, fmt.Errorf("inspect private file: %w", err)
	}
	if !info.Mode().IsRegular() {
		return nil, fmt.Errorf("path is not a regular file")
	}
	ownerID, ok := fileOwnerID(info)
	if !ok || ownerID != uint32(os.Getuid()) {
		return nil, fmt.Errorf("private file owner is not trusted")
	}
	if info.Mode().Perm()&0o077 != 0 {
		return nil, fmt.Errorf("private file permissions are too broad")
	}

	return info, nil
}

// validateSecurePathComponents は各パス要素のsymlink・所有者・書込権限を検証する。
func validateSecurePathComponents(path string) error {
	cleanPath := filepath.Clean(path)
	if !filepath.IsAbs(cleanPath) {
		return fmt.Errorf("path is not absolute")
	}

	currentPath := string(filepath.Separator)
	rootInfo, err := os.Lstat(currentPath)
	if err != nil {
		return fmt.Errorf("inspect filesystem root: %w", err)
	}
	if err := validateTrustedPathInfo(rootInfo); err != nil {
		return err
	}

	components := strings.Split(strings.TrimPrefix(cleanPath, string(filepath.Separator)), string(filepath.Separator))
	for index, component := range components {
		if component == "" {
			continue
		}

		currentPath = filepath.Join(currentPath, component)
		info, err := os.Lstat(currentPath)
		if err != nil {
			return fmt.Errorf("inspect path component %q: %w", currentPath, err)
		}
		if err := validateTrustedPathInfo(info); err != nil {
			return fmt.Errorf("validate path component %q: %w", currentPath, err)
		}
		if index < len(components)-1 && !info.IsDir() {
			return fmt.Errorf("path component %q is not a directory", currentPath)
		}
	}

	return nil
}

// validateTrustedPathInfo はファイル情報の所有者と書込権限を検証する。
func validateTrustedPathInfo(info os.FileInfo) error {
	if info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("symbolic links are not allowed")
	}

	ownerID, ok := fileOwnerID(info)
	if !ok {
		return fmt.Errorf("file owner is unavailable")
	}
	currentUserID := uint32(os.Getuid())
	if ownerID != 0 && ownerID != currentUserID {
		return fmt.Errorf("file owner is not trusted")
	}
	if info.Mode().Perm()&0o022 != 0 {
		return fmt.Errorf("group or other write permission is not allowed")
	}

	return nil
}

// fileOwnerID はmacOSのファイル情報から所有者IDを取得する。
func fileOwnerID(info os.FileInfo) (uint32, bool) {
	status, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return 0, false
	}

	return status.Uid, true
}
