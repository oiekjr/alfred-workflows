package githubrepos

import (
	"encoding/base64"
	"fmt"
	"os"
	"path/filepath"
)

// currentLoginHelperToken は実行中バイナリの検証済み絶対パスを安全な転送形式へ変換する。
func currentLoginHelperToken() (string, error) {
	executablePath, err := os.Executable()
	if err != nil {
		return "", fmt.Errorf("resolve workflow executable: %w", err)
	}
	executablePath, err = filepath.EvalSymlinks(executablePath)
	if err != nil {
		return "", fmt.Errorf("resolve workflow executable links: %w", err)
	}
	if !filepath.IsAbs(executablePath) {
		return "", fmt.Errorf("workflow executable path is not absolute")
	}
	if err := validateSecurePathComponents(executablePath); err != nil {
		return "", fmt.Errorf("validate workflow executable path: %w", err)
	}

	info, err := os.Lstat(executablePath)
	if err != nil {
		return "", fmt.Errorf("inspect workflow executable: %w", err)
	}
	ownerID, ok := fileOwnerID(info)
	if !ok || ownerID != uint32(os.Getuid()) {
		return "", fmt.Errorf("workflow executable owner is not trusted")
	}
	if !info.Mode().IsRegular() ||
		info.Mode().Perm()&0o111 == 0 ||
		info.Mode().Perm()&0o022 != 0 {
		return "", fmt.Errorf("workflow executable permissions are unsafe")
	}

	return base64.StdEncoding.EncodeToString([]byte(executablePath)), nil
}
