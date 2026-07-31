package githubrepos

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// TestListCacheStoresValidatedRepositoriesPrivately は一覧キャッシュの権限と正規化を検証する。
func TestListCacheStoresValidatedRepositoriesPrivately(t *testing.T) {
	rootDirectory := secureTempDirectory(t)
	currentTime := time.Now()
	cache := newListCache(rootDirectory, func() time.Time {
		return currentTime
	})
	longDescription := strings.Repeat("a", repositoryDescriptionLimit+100)
	repositories := []repository{
		{
			ID:          2,
			FullName:    "zeta/repo",
			HTMLURL:     "https://github.com/zeta/repo",
			Description: &longDescription,
		},
		{
			ID:       1,
			FullName: "Alpha/repo",
			HTMLURL:  "https://github.com/Alpha/repo",
		},
	}

	if err := cache.StoreRepositories(repositories); err != nil {
		t.Fatalf("store repositories: %v", err)
	}
	currentTime = time.Now()
	loadedRepositories, ok := cache.LoadRepositories()

	if !ok || len(loadedRepositories) != 2 {
		t.Fatalf("loaded repositories = %#v, %t", loadedRepositories, ok)
	}
	if loadedRepositories[0].FullName != "Alpha/repo" ||
		loadedRepositories[1].FullName != "zeta/repo" {
		t.Fatalf("repository order = %#v", loadedRepositories)
	}
	if loadedRepositories[1].Description == nil ||
		len(*loadedRepositories[1].Description) > repositoryDescriptionLimit+len("…") {
		t.Fatalf("description was not bounded: %#v", loadedRepositories[1].Description)
	}

	path := cache.path(repositoryListCacheName)
	info, err := validatePrivateRegularFile(path)
	if err != nil {
		t.Fatalf("validate repository cache: %v", err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("repository cache permissions = %o, want 600", info.Mode().Perm())
	}
}

// TestListCacheExpiresAndDeletesData は期限切れ一覧を表示せず削除することを検証する。
func TestListCacheExpiresAndDeletesData(t *testing.T) {
	rootDirectory := secureTempDirectory(t)
	currentTime := time.Now()
	cache := newListCache(rootDirectory, func() time.Time {
		return currentTime
	})
	repositories := []repository{{
		ID:       1,
		FullName: "owner/repo",
		HTMLURL:  "https://github.com/owner/repo",
	}}
	if err := cache.StoreRepositories(repositories); err != nil {
		t.Fatalf("store repositories: %v", err)
	}

	path := cache.path(repositoryListCacheName)
	expiredTime := currentTime.Add(-listCacheLifetime - time.Second)
	if err := os.Chtimes(path, expiredTime, expiredTime); err != nil {
		t.Fatalf("expire repository cache: %v", err)
	}

	_, ok := cache.LoadRepositories()

	if ok {
		t.Fatal("expired repository cache was loaded")
	}
	if _, err := os.Lstat(path); !os.IsNotExist(err) {
		t.Fatalf("expired repository cache still exists: %v", err)
	}
}

// TestListCacheRejectsModifiedProjectData は改変されたProjectキャッシュを拒否する。
func TestListCacheRejectsModifiedProjectData(t *testing.T) {
	rootDirectory := secureTempDirectory(t)
	cache := newListCache(rootDirectory, time.Now)
	invalidProject := project{
		ID:      "PVT_1",
		Number:  1,
		Title:   "Unsafe",
		HTMLURL: "https://example.com/orgs/example-org/projects/1",
		Public:  true,
		Owner: githubOwner{
			ID:        1,
			NodeID:    "O_1",
			Login:     "example-org",
			AvatarURL: "https://avatars.githubusercontent.com/u/1?v=4",
			Type:      "Organization",
		},
	}
	if err := cache.store(projectListCacheName, projectListCacheDocument{
		Schema:   listCacheSchemaVersion,
		Projects: []project{invalidProject},
	}); err != nil {
		t.Fatalf("write modified project cache: %v", err)
	}

	_, ok := cache.LoadProjects()

	if ok {
		t.Fatal("modified project cache was loaded")
	}
	if _, err := os.Lstat(cache.path(projectListCacheName)); !os.IsNotExist(err) {
		t.Fatalf("modified project cache still exists: %v", err)
	}
}

// TestListCacheInvalidatesOnlyListFiles は認証時の一覧削除範囲を検証する。
func TestListCacheInvalidatesOnlyListFiles(t *testing.T) {
	rootDirectory := secureTempDirectory(t)
	cache := newListCache(rootDirectory, time.Now)
	if err := cache.StoreRepositories([]repository{{
		ID:       1,
		FullName: "owner/repo",
		HTMLURL:  "https://github.com/owner/repo",
	}}); err != nil {
		t.Fatalf("store repositories: %v", err)
	}
	if err := cache.StoreProjects([]project{{
		ID:      "PVT_1",
		Number:  1,
		Title:   "Roadmap",
		HTMLURL: "https://github.com/orgs/example-org/projects/1",
		Public:  true,
		Owner: githubOwner{
			ID:        1,
			NodeID:    "O_1",
			Login:     "example-org",
			AvatarURL: "https://avatars.githubusercontent.com/u/1?v=4",
			Type:      "Organization",
		},
	}}); err != nil {
		t.Fatalf("store projects: %v", err)
	}
	avatarDirectory, err := ensureSecureCacheSubdirectory(rootDirectory, "avatars")
	if err != nil {
		t.Fatalf("create avatar directory: %v", err)
	}
	avatarPath := filepath.Join(avatarDirectory, "1.png")
	if err := os.WriteFile(avatarPath, testPNG(t), 0o600); err != nil {
		t.Fatalf("write avatar: %v", err)
	}

	if err := cache.Invalidate(); err != nil {
		t.Fatalf("invalidate list cache: %v", err)
	}

	for _, name := range []string{repositoryListCacheName, projectListCacheName} {
		if _, err := os.Lstat(cache.path(name)); !os.IsNotExist(err) {
			t.Fatalf("list cache %q still exists: %v", name, err)
		}
	}
	if _, err := os.Stat(avatarPath); err != nil {
		t.Fatalf("avatar was removed with list cache: %v", err)
	}
}
