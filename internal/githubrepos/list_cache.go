package githubrepos

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"
)

const (
	listCacheLifetime       = 5 * time.Minute
	listCacheDirectory      = "lists"
	listCacheSchemaVersion  = 2
	repositoryListCacheName = "repositories.json"
	projectListCacheName    = "projects.json"
)

// listCacheProvider は検証済みGitHub一覧の短期キャッシュを提供する。
type listCacheProvider interface {
	LoadRepositories(config githubConfigIdentity) ([]repository, bool)
	StoreRepositories(
		account githubAccountIdentity,
		repositories []repository,
	) error
	LoadProjects(config githubConfigIdentity) ([]project, bool)
	StoreProjects(account githubAccountIdentity, projects []project) error
	Invalidate() error
}

type listCache struct {
	rootDirectory string
	now           func() time.Time
}

type repositoryListCacheDocument struct {
	Schema       int                   `json:"schema"`
	Account      githubAccountIdentity `json:"account"`
	Repositories []repository          `json:"repositories"`
}

type projectListCacheDocument struct {
	Schema   int                   `json:"schema"`
	Account  githubAccountIdentity `json:"account"`
	Projects []project             `json:"projects"`
}

// newEnvironmentListCache はAlfredの専用キャッシュを使用して初期化する。
func newEnvironmentListCache() *listCache {
	return newListCache(trustedAlfredCacheRootFromEnvironment(), time.Now)
}

// newListCache は指定した非公開領域と時刻関数で初期化する。
func newListCache(rootDirectory string, now func() time.Time) *listCache {
	return &listCache{
		rootDirectory: rootDirectory,
		now:           now,
	}
}

// LoadRepositories は現在のGitHubアカウント用リポジトリ一覧を返す。
func (cache *listCache) LoadRepositories(
	config githubConfigIdentity,
) ([]repository, bool) {
	if cache == nil || !config.valid() {
		return nil, false
	}

	var document repositoryListCacheDocument
	if !cache.load(repositoryListCacheName, &document) ||
		document.Schema != listCacheSchemaVersion ||
		!document.Account.valid() ||
		document.Account.Config != config {
		cache.invalidateFile(repositoryListCacheName)
		return nil, false
	}

	repositories, validCount := normalizeRepositories(document.Repositories)
	if validCount != len(document.Repositories) {
		cache.invalidateFile(repositoryListCacheName)
		return nil, false
	}

	return repositories, true
}

// StoreRepositories はアカウント単位の検証済みリポジトリ一覧を保存する。
func (cache *listCache) StoreRepositories(
	account githubAccountIdentity,
	repositories []repository,
) error {
	if !account.valid() {
		return fmt.Errorf("repository cache account is invalid")
	}
	normalizedRepositories, validCount := normalizeRepositories(repositories)
	if validCount != len(repositories) {
		return fmt.Errorf("repository cache contains invalid entries")
	}

	return cache.store(repositoryListCacheName, repositoryListCacheDocument{
		Schema:       listCacheSchemaVersion,
		Account:      account,
		Repositories: normalizedRepositories,
	})
}

// LoadProjects は現在のGitHubアカウント用Open Project一覧を返す。
func (cache *listCache) LoadProjects(
	config githubConfigIdentity,
) ([]project, bool) {
	if cache == nil || !config.valid() {
		return nil, false
	}

	var document projectListCacheDocument
	if !cache.load(projectListCacheName, &document) ||
		document.Schema != listCacheSchemaVersion ||
		!document.Account.valid() ||
		document.Account.Config != config {
		cache.invalidateFile(projectListCacheName)
		return nil, false
	}

	projects, validCount, openCount := normalizeProjects(document.Projects)
	if validCount != len(document.Projects) ||
		openCount != len(document.Projects) {
		cache.invalidateFile(projectListCacheName)
		return nil, false
	}

	return projects, true
}

// StoreProjects はアカウント単位の検証済みOpen Project一覧を保存する。
func (cache *listCache) StoreProjects(
	account githubAccountIdentity,
	projects []project,
) error {
	if !account.valid() {
		return fmt.Errorf("project cache account is invalid")
	}
	normalizedProjects, validCount, openCount := normalizeProjects(projects)
	if validCount != len(projects) || openCount != len(projects) {
		return fmt.Errorf("project cache contains invalid entries")
	}

	return cache.store(projectListCacheName, projectListCacheDocument{
		Schema:   listCacheSchemaVersion,
		Account:  account,
		Projects: normalizedProjects,
	})
}

// Invalidate はGitHub一覧の短期キャッシュだけを削除する。
func (cache *listCache) Invalidate() error {
	if cache == nil || cache.rootDirectory == "" || !filepath.IsAbs(cache.rootDirectory) {
		return nil
	}

	var invalidateErrors []error
	for _, name := range []string{repositoryListCacheName, projectListCacheName} {
		if err := cache.removeFile(name); err != nil {
			invalidateErrors = append(invalidateErrors, err)
		}
	}

	return errors.Join(invalidateErrors...)
}

// InvalidateListCache は現在のワークフロー用GitHub一覧キャッシュを無効化する。
func InvalidateListCache() error {
	rootDirectory, err := expectedAlfredCacheRoot()
	if err != nil {
		return err
	}

	return newListCache(rootDirectory, time.Now).Invalidate()
}

// load は固定名のキャッシュ文書を容量・権限・期限付きで読み込む。
func (cache *listCache) load(name string, destination any) bool {
	if cache == nil ||
		cache.now == nil ||
		cache.rootDirectory == "" ||
		!filepath.IsAbs(cache.rootDirectory) {
		return false
	}

	path := cache.path(name)
	info, err := validatePrivateRegularFile(path)
	if err != nil {
		return false
	}

	age := cache.now().Sub(info.ModTime())
	if age < 0 || age > listCacheLifetime {
		cache.invalidateFile(name)
		return false
	}

	data, err := readPrivateFile(path, apiOutputLimit)
	if err != nil {
		cache.invalidateFile(name)
		return false
	}

	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		cache.invalidateFile(name)
		return false
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		cache.invalidateFile(name)
		return false
	}

	return true
}

// store は固定名のキャッシュ文書を容量制限付きでアトミックに保存する。
func (cache *listCache) store(name string, document any) error {
	if cache == nil ||
		cache.rootDirectory == "" ||
		!filepath.IsAbs(cache.rootDirectory) {
		return fmt.Errorf("list cache is unavailable")
	}

	data, err := json.Marshal(document)
	if err != nil {
		return fmt.Errorf("encode list cache: %w", err)
	}
	if len(data) > apiOutputLimit {
		return fmt.Errorf("list cache exceeds size limit")
	}

	directory, err := ensureSecureCacheSubdirectory(cache.rootDirectory, listCacheDirectory)
	if err != nil {
		return fmt.Errorf("prepare list cache: %w", err)
	}

	return writePrivateFileAtomically(
		directory,
		name,
		func(file *os.File) error {
			if _, writeErr := file.Write(data); writeErr != nil {
				return fmt.Errorf("write list cache: %w", writeErr)
			}

			return nil
		},
	)
}

// path は固定したキャッシュファイル名の絶対パスを返す。
func (cache *listCache) path(name string) string {
	return filepath.Join(cache.rootDirectory, listCacheDirectory, name)
}

// invalidateFile は検証済み通常ファイルだけを削除する。
func (cache *listCache) invalidateFile(name string) {
	if cache == nil {
		return
	}

	_ = cache.removeFile(name)
}

// removeFile は固定名の検証済みキャッシュファイルを削除する。
func (cache *listCache) removeFile(name string) error {
	path := cache.path(name)
	if _, err := validatePrivateRegularFile(path); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}

		return err
	}
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("remove list cache: %w", err)
	}

	return nil
}
