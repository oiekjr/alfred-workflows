package githubrepos

import (
	"bytes"
	"context"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"
)

// TestAvatarCacheDownloadsAndReusesImage はアバターの取得と再利用を検証する。
func TestAvatarCacheDownloadsAndReusesImage(t *testing.T) {
	imageData := testPNG(t)
	var requestCount atomic.Int32
	client := &http.Client{
		Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
			requestCount.Add(1)
			if request.URL.Query().Get("s") != avatarImageSize {
				return nil, fmt.Errorf("avatar size is not set")
			}

			return &http.Response{
				StatusCode:    http.StatusOK,
				Body:          io.NopCloser(bytes.NewReader(imageData)),
				ContentLength: int64(len(imageData)),
				Header:        make(http.Header),
				Request:       request,
			}, nil
		}),
	}
	cacheDirectory := secureTempDirectory(t)
	cache := newAvatarCache(cacheDirectory, client)
	owner := repositoryOwner{
		ID:        1,
		Login:     "octocat",
		AvatarURL: "https://avatars.githubusercontent.com/u/1?v=4",
		Type:      "User",
	}

	firstPaths := cache.Paths(context.Background(), []repositoryOwner{owner})
	secondPaths := cache.Paths(context.Background(), []repositoryOwner{owner})

	expectedPath := filepath.Join(cacheDirectory, "avatars", "1.png")
	if firstPaths[owner.ID] != expectedPath || secondPaths[owner.ID] != expectedPath {
		t.Fatalf("paths = %#v and %#v, want %q", firstPaths, secondPaths, expectedPath)
	}
	info, err := os.Stat(expectedPath)
	if err != nil {
		t.Fatalf("stat cached avatar: %v", err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Errorf("permissions = %o, want 600", info.Mode().Perm())
	}
	if requestCount.Load() != 1 {
		t.Errorf("request count = %d, want 1", requestCount.Load())
	}
}

// TestAvatarCacheRejectsUnsupportedHost はGitHub以外の画像URLを拒否する。
func TestAvatarCacheRejectsUnsupportedHost(t *testing.T) {
	var requestCount atomic.Int32
	client := &http.Client{
		Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
			requestCount.Add(1)
			return nil, fmt.Errorf("unexpected request to %s", request.URL)
		}),
	}
	cache := newAvatarCache(secureTempDirectory(t), client)
	owner := repositoryOwner{
		ID:        1,
		Login:     "octocat",
		AvatarURL: "https://example.com/avatar.png",
		Type:      "User",
	}

	paths := cache.Paths(context.Background(), []repositoryOwner{owner})

	if len(paths) != 0 {
		t.Fatalf("paths = %#v, want empty", paths)
	}
	if requestCount.Load() != 0 {
		t.Errorf("request count = %d, want 0", requestCount.Load())
	}
}

// TestAvatarCacheUsesStaleImageWhenRefreshFails は更新失敗時の既存画像利用を検証する。
func TestAvatarCacheUsesStaleImageWhenRefreshFails(t *testing.T) {
	cacheDirectory := secureTempDirectory(t)
	client := &http.Client{
		Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
			return nil, fmt.Errorf("temporary failure for %s", request.URL)
		}),
	}
	cache := newAvatarCache(cacheDirectory, client)
	owner := repositoryOwner{
		ID:        1,
		Login:     "octocat",
		AvatarURL: "https://avatars.githubusercontent.com/u/1?v=4",
		Type:      "User",
	}
	cachedPath := cache.path(owner.ID)
	if err := os.MkdirAll(filepath.Dir(cachedPath), 0o700); err != nil {
		t.Fatalf("create avatar directory: %v", err)
	}
	if err := os.WriteFile(cachedPath, testPNG(t), 0o600); err != nil {
		t.Fatalf("write cached avatar: %v", err)
	}
	expiredTime := time.Now().Add(-avatarCacheLifetime - time.Hour)
	if err := os.Chtimes(cachedPath, expiredTime, expiredTime); err != nil {
		t.Fatalf("expire cached avatar: %v", err)
	}

	paths := cache.Paths(context.Background(), []repositoryOwner{owner})

	if paths[owner.ID] != cachedPath {
		t.Fatalf("path = %q, want %q", paths[owner.ID], cachedPath)
	}
}

// TestAvatarCacheRejectsSymlinkDirectory はsymlink経由のキャッシュ保存を拒否する。
func TestAvatarCacheRejectsSymlinkDirectory(t *testing.T) {
	cacheDirectory := secureTempDirectory(t)
	targetDirectory := secureTempDirectory(t)
	if err := os.Symlink(targetDirectory, filepath.Join(cacheDirectory, "avatars")); err != nil {
		t.Fatalf("create avatar symlink: %v", err)
	}
	var requestCount atomic.Int32
	client := &http.Client{
		Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
			requestCount.Add(1)
			return nil, fmt.Errorf("unexpected request to %s", request.URL)
		}),
	}
	cache := newAvatarCache(cacheDirectory, client)
	owner := repositoryOwner{
		ID:        1,
		Login:     "octocat",
		AvatarURL: "https://avatars.githubusercontent.com/u/1?v=4",
		Type:      "User",
	}

	paths := cache.Paths(context.Background(), []repositoryOwner{owner})

	if len(paths) != 0 {
		t.Fatalf("paths = %#v, want empty", paths)
	}
	if requestCount.Load() != 0 {
		t.Errorf("request count = %d, want 0", requestCount.Load())
	}
}

// TestAvatarHTTPClientDisablesEnvironmentProxy は環境変数由来のproxyを使用しないことを検証する。
func TestAvatarHTTPClientDisablesEnvironmentProxy(t *testing.T) {
	client := newAvatarHTTPClient()

	transport, ok := client.Transport.(*http.Transport)
	if !ok {
		t.Fatalf("transport type = %T, want *http.Transport", client.Transport)
	}
	if transport.Proxy != nil {
		t.Error("proxy function is configured, want direct connection")
	}
}

// secureTempDirectory はsymlinkを解決したテスト専用ディレクトリを返す。
func secureTempDirectory(t *testing.T) string {
	t.Helper()

	directory, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatalf("resolve temporary directory: %v", err)
	}
	if err := os.Chmod(directory, 0o700); err != nil {
		t.Fatalf("restrict temporary directory: %v", err)
	}

	return directory
}

// testPNG はテスト用の小さなPNG画像を生成する。
func testPNG(t *testing.T) []byte {
	t.Helper()

	avatar := image.NewRGBA(image.Rect(0, 0, 2, 2))
	avatar.Set(0, 0, color.RGBA{R: 255, A: 255})

	var output bytes.Buffer
	if err := png.Encode(&output, avatar); err != nil {
		t.Fatalf("encode test PNG: %v", err)
	}

	return output.Bytes()
}

type roundTripFunc func(request *http.Request) (*http.Response, error)

// RoundTrip は関数で定義したテスト用HTTP応答を返す。
func (function roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return function(request)
}
