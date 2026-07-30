package githubrepos

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// TestPackageScriptRejectsWorkflowAncestorSymlink は外部入力へ向く祖先symlinkを拒否する。
func TestPackageScriptRejectsWorkflowAncestorSymlink(t *testing.T) {
	scriptData, err := os.ReadFile("../../scripts/package.sh")
	if err != nil {
		t.Fatalf("read package script: %v", err)
	}

	projectDirectory := secureTempDirectory(t)
	scriptDirectory := filepath.Join(projectDirectory, "scripts")
	if err := os.Mkdir(scriptDirectory, 0o755); err != nil {
		t.Fatalf("create script directory: %v", err)
	}
	scriptPath := filepath.Join(scriptDirectory, "package.sh")
	if err := os.WriteFile(scriptPath, scriptData, 0o755); err != nil {
		t.Fatalf("write package script: %v", err)
	}
	if err := os.Mkdir(filepath.Join(projectDirectory, "build"), 0o755); err != nil {
		t.Fatalf("create build directory: %v", err)
	}

	externalDirectory := filepath.Join(secureTempDirectory(t), "github-repositories")
	if err := os.Mkdir(externalDirectory, 0o755); err != nil {
		t.Fatalf("create external workflow directory: %v", err)
	}
	if err := os.WriteFile(filepath.Join(externalDirectory, "info.plist"), []byte("<plist/>"), 0o644); err != nil {
		t.Fatalf("write external plist: %v", err)
	}
	if err := os.Symlink(filepath.Dir(externalDirectory), filepath.Join(projectDirectory, "workflows")); err != nil {
		t.Fatalf("create workflow ancestor symlink: %v", err)
	}

	process := exec.Command("/bin/bash", scriptPath)
	output, runErr := process.CombinedOutput()

	if runErr == nil {
		t.Fatal("package script succeeded, want ancestor symlink rejection")
	}
	if !strings.Contains(string(output), "resolves through an unexpected directory") {
		t.Fatalf("package output = %q", output)
	}
}

// TestBuildScriptUsesPinnedMisePath はPATH検索ではなく固定したmise導入先を使う。
func TestBuildScriptUsesPinnedMisePath(t *testing.T) {
	scriptData, err := os.ReadFile("../../scripts/build.sh")
	if err != nil {
		t.Fatalf("read build script: %v", err)
	}
	script := string(scriptData)

	if strings.Contains(script, "command -v go") {
		t.Fatal("build script resolves Go from PATH")
	}
	if !strings.Contains(script, "go_version=\"1.26.5\"") ||
		!strings.Contains(script, ".local/share/mise/installs/go/$go_version") {
		t.Fatal("build script does not use the pinned mise installation")
	}
}
