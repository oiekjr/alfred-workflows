package githubrepos

import (
	"bytes"
	"context"
	"crypto/tls"
	"fmt"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	"image/png"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	avatarCacheLifetime          = 7 * 24 * time.Hour
	avatarDownloadTimeout        = 2 * time.Second
	maxConcurrentAvatarDownloads = 4
	maxAvatarDownloadsPerRun     = 24
	maxAvatarResponseBytes       = 2 * 1024 * 1024
	maxAvatarDimension           = 1024
	avatarImageSize              = "128"
)

// avatarProvider は所有者ごとのローカルアバターパスを提供する。
type avatarProvider interface {
	Paths(ctx context.Context, owners []githubOwner) map[int64]string
}

type avatarCache struct {
	rootDirectory string
	client        *http.Client
	now           func() time.Time
}

// newEnvironmentAvatarCache は Alfred が提供するキャッシュ領域を使用して初期化する。
func newEnvironmentAvatarCache() *avatarCache {
	return newAvatarCache(
		trustedAlfredCacheRootFromEnvironment(),
		newAvatarHTTPClient(),
	)
}

// newAvatarCache は指定した保存先とHTTPクライアントで初期化する。
func newAvatarCache(rootDirectory string, client *http.Client) *avatarCache {
	return &avatarCache{
		rootDirectory: rootDirectory,
		client:        client,
		now:           time.Now,
	}
}

// newAvatarHTTPClient はGitHubのアバター配信先だけへ接続するクライアントを初期化する。
func newAvatarHTTPClient() *http.Client {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = nil
	transport.TLSClientConfig = &tls.Config{MinVersion: tls.VersionTLS12}

	return &http.Client{
		Transport: transport,
		Timeout:   avatarDownloadTimeout,
		CheckRedirect: func(request *http.Request, previousRequests []*http.Request) error {
			if len(previousRequests) >= 3 {
				return fmt.Errorf("too many avatar redirects")
			}
			if !isAllowedAvatarURL(request.URL) {
				return fmt.Errorf("redirect to unsupported avatar URL")
			}
			if len(previousRequests) > 0 &&
				request.URL.Path != previousRequests[0].URL.Path {
				return fmt.Errorf("redirect changed avatar identity")
			}

			return nil
		},
	}
}

// Paths はキャッシュ済み画像を返し、必要な画像だけを制限付きで取得する。
func (cache *avatarCache) Paths(parentContext context.Context, owners []githubOwner) map[int64]string {
	paths := make(map[int64]string)
	if cache == nil ||
		cache.client == nil ||
		cache.rootDirectory == "" ||
		!filepath.IsAbs(cache.rootDirectory) {
		return paths
	}
	if _, err := ensureSecureCacheSubdirectory(cache.rootDirectory, "avatars"); err != nil {
		return paths
	}

	downloadOwners := make([]githubOwner, 0)
	seenOwnerIDs := make(map[int64]struct{})
	for _, owner := range owners {
		if owner.ID <= 0 {
			continue
		}
		if _, exists := seenOwnerIDs[owner.ID]; exists {
			continue
		}
		seenOwnerIDs[owner.ID] = struct{}{}

		path := cache.path(owner.ID)
		info, err := validatePrivateRegularFile(path)
		if err == nil {
			paths[owner.ID] = path
			if cache.isFresh(info.ModTime()) {
				continue
			}
		}

		if len(downloadOwners) < maxAvatarDownloadsPerRun {
			if _, err := normalizedAvatarURL(owner.AvatarURL, owner.ID); err == nil {
				downloadOwners = append(downloadOwners, owner)
			}
		}
	}

	if len(downloadOwners) == 0 {
		return paths
	}

	ctx, cancel := context.WithTimeout(parentContext, avatarDownloadTimeout)
	defer cancel()

	jobs := make(chan githubOwner, len(downloadOwners))
	for _, owner := range downloadOwners {
		jobs <- owner
	}
	close(jobs)

	workerCount := min(maxConcurrentAvatarDownloads, len(downloadOwners))
	var workers sync.WaitGroup
	var pathsMutex sync.Mutex
	workers.Add(workerCount)

	for range workerCount {
		go func() {
			defer workers.Done()

			for owner := range jobs {
				path, err := cache.download(ctx, owner)
				if err != nil {
					continue
				}

				pathsMutex.Lock()
				paths[owner.ID] = path
				pathsMutex.Unlock()
			}
		}()
	}

	workers.Wait()

	return paths
}

// path は所有者IDから安全なキャッシュファイル名を生成する。
func (cache *avatarCache) path(ownerID int64) string {
	return filepath.Join(
		cache.rootDirectory,
		"avatars",
		strconv.FormatInt(ownerID, 10)+".png",
	)
}

// isFresh はキャッシュファイルが有効期間内か判定する。
func (cache *avatarCache) isFresh(modificationTime time.Time) bool {
	age := cache.now().Sub(modificationTime)
	return age >= 0 && age <= avatarCacheLifetime
}

// download はアバターを検証し、PNGとしてアトミックに保存する。
func (cache *avatarCache) download(ctx context.Context, owner githubOwner) (string, error) {
	avatarURL, err := normalizedAvatarURL(owner.AvatarURL, owner.ID)
	if err != nil {
		return "", err
	}

	request, err := http.NewRequestWithContext(ctx, http.MethodGet, avatarURL, nil)
	if err != nil {
		return "", fmt.Errorf("create avatar request: %w", err)
	}
	request.Header.Set("Accept", "image/png,image/jpeg,image/gif")
	request.Header.Set("User-Agent", "alfred-github-repositories")

	response, err := cache.client.Do(request)
	if err != nil {
		return "", fmt.Errorf("download avatar: %w", err)
	}
	defer response.Body.Close()

	if response.StatusCode != http.StatusOK {
		return "", fmt.Errorf("unexpected avatar status: %d", response.StatusCode)
	}
	if response.ContentLength > maxAvatarResponseBytes {
		return "", fmt.Errorf("avatar exceeds size limit")
	}

	data, err := io.ReadAll(io.LimitReader(response.Body, maxAvatarResponseBytes+1))
	if err != nil {
		return "", fmt.Errorf("read avatar: %w", err)
	}
	if len(data) > maxAvatarResponseBytes {
		return "", fmt.Errorf("avatar exceeds size limit")
	}

	avatar, err := decodeAvatar(data)
	if err != nil {
		return "", err
	}

	path := cache.path(owner.ID)
	if err := writePNGAtomically(path, avatar); err != nil {
		return "", err
	}

	return path, nil
}

// normalizedAvatarURL は許可したGitHub配信先へ画像サイズ指定を追加する。
func normalizedAvatarURL(rawURL string, ownerID int64) (string, error) {
	parsedURL, err := url.Parse(rawURL)
	if err != nil {
		return "", fmt.Errorf("unsupported avatar URL")
	}
	avatarOwnerID, err := avatarOwnerIDFromURL(parsedURL)
	if err != nil || avatarOwnerID != ownerID {
		return "", fmt.Errorf("avatar owner does not match GitHub owner")
	}

	query := make(url.Values)
	query.Set("s", avatarImageSize)
	parsedURL.RawQuery = query.Encode()

	return parsedURL.String(), nil
}

// avatarOwnerIDFromURL は許可したGitHubアバターURLから所有者IDを取得する。
func avatarOwnerIDFromURL(parsedURL *url.URL) (int64, error) {
	if !isAllowedAvatarURL(parsedURL) {
		return 0, fmt.Errorf("unsupported avatar URL")
	}

	ownerID, err := strconv.ParseInt(strings.TrimPrefix(parsedURL.Path, "/u/"), 10, 64)
	if err != nil || ownerID <= 0 {
		return 0, fmt.Errorf("unsupported avatar owner")
	}

	return ownerID, nil
}

// isAllowedAvatarURL はHTTPSのGitHubアバター配信先だけを許可する。
func isAllowedAvatarURL(parsedURL *url.URL) bool {
	if parsedURL == nil ||
		parsedURL.Scheme != "https" ||
		parsedURL.User != nil ||
		parsedURL.Fragment != "" ||
		parsedURL.RawPath != "" ||
		parsedURL.Opaque != "" {
		return false
	}

	ownerID := strings.TrimPrefix(parsedURL.Path, "/u/")
	if ownerID == parsedURL.Path || ownerID == "" || strings.Contains(ownerID, "/") {
		return false
	}
	if _, err := strconv.ParseUint(ownerID, 10, 64); err != nil {
		return false
	}

	return parsedURL.Host == "avatars.githubusercontent.com"
}

// decodeAvatar は画像形式と展開後の寸法を検証してデコードする。
func decodeAvatar(data []byte) (image.Image, error) {
	config, _, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil {
		return nil, fmt.Errorf("decode avatar configuration: %w", err)
	}
	if config.Width <= 0 ||
		config.Height <= 0 ||
		config.Width > maxAvatarDimension ||
		config.Height > maxAvatarDimension {
		return nil, fmt.Errorf("avatar dimensions are unsupported")
	}

	avatar, _, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		return nil, fmt.Errorf("decode avatar: %w", err)
	}

	return avatar, nil
}

// writePNGAtomically は一時ファイルを経由してPNG画像を保存する。
func writePNGAtomically(destinationPath string, avatar image.Image) error {
	directory := filepath.Dir(destinationPath)
	encoder := png.Encoder{CompressionLevel: png.BestSpeed}

	return writePrivateFileAtomically(
		directory,
		filepath.Base(destinationPath),
		func(file *os.File) error {
			if err := encoder.Encode(file, avatar); err != nil {
				return fmt.Errorf("encode avatar: %w", err)
			}

			return nil
		},
	)
}
