package githubrepos

import (
	"os"
	"path/filepath"
	"testing"
)

// TestValidatePrivateDirectoryRejectsBroadPermissions は共有可能なキャッシュ領域を拒否する。
func TestValidatePrivateDirectoryRejectsBroadPermissions(t *testing.T) {
	directory := secureTempDirectory(t)
	if err := os.Chmod(directory, 0o755); err != nil {
		t.Fatalf("broaden directory permissions: %v", err)
	}

	err := validatePrivateDirectory(directory)

	if err == nil {
		t.Fatal("validate private directory succeeded, want error")
	}
}

// TestWritePrivateFileAtomicallyUsesPrivatePermissions はキャッシュファイルの権限を検証する。
func TestWritePrivateFileAtomicallyUsesPrivatePermissions(t *testing.T) {
	rootDirectory := secureTempDirectory(t)
	directory, err := ensureSecureCacheSubdirectory(rootDirectory, "data")
	if err != nil {
		t.Fatalf("create secure cache directory: %v", err)
	}

	err = writePrivateFileAtomically(directory, "value.json", func(file *os.File) error {
		_, writeErr := file.WriteString(`{"value":"safe"}`)
		return writeErr
	})

	if err != nil {
		t.Fatalf("write private file: %v", err)
	}
	path := filepath.Join(directory, "value.json")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read private file: %v", err)
	}
	info, err := validatePrivateRegularFile(path)
	if err != nil {
		t.Fatalf("validate private file: %v", err)
	}
	if string(data) != `{"value":"safe"}` {
		t.Errorf("data = %q", data)
	}
	if info.Mode().Perm() != 0o600 {
		t.Errorf("permissions = %o, want 600", info.Mode().Perm())
	}
}

// TestWritePrivateFileAtomicallyRejectsDestinationSymlink は既存symlinkの置換を拒否する。
func TestWritePrivateFileAtomicallyRejectsDestinationSymlink(t *testing.T) {
	rootDirectory := secureTempDirectory(t)
	directory, err := ensureSecureCacheSubdirectory(rootDirectory, "data")
	if err != nil {
		t.Fatalf("create secure cache directory: %v", err)
	}
	targetPath := filepath.Join(rootDirectory, "target")
	if err := os.WriteFile(targetPath, []byte("keep"), 0o600); err != nil {
		t.Fatalf("write target file: %v", err)
	}
	if err := os.Symlink(targetPath, filepath.Join(directory, "value.json")); err != nil {
		t.Fatalf("create destination symlink: %v", err)
	}

	err = writePrivateFileAtomically(directory, "value.json", func(file *os.File) error {
		_, writeErr := file.WriteString("replace")
		return writeErr
	})

	if err == nil {
		t.Fatal("write private file succeeded, want error")
	}
	data, readErr := os.ReadFile(targetPath)
	if readErr != nil {
		t.Fatalf("read target file: %v", readErr)
	}
	if string(data) != "keep" {
		t.Errorf("target data = %q, want keep", data)
	}
}

// TestTrustedAlfredCacheRootRejectsUnexpectedPath は任意の保存先指定を拒否する。
func TestTrustedAlfredCacheRootRejectsUnexpectedPath(t *testing.T) {
	t.Setenv("alfred_workflow_cache", "/tmp/untrusted-cache")

	rootDirectory := trustedAlfredCacheRootFromEnvironment()

	if rootDirectory != "" {
		t.Errorf("cache root = %q, want empty", rootDirectory)
	}
}
