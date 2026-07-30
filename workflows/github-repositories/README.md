# GitHub Repositories

GitHub CLI のアクティブなアカウントが閲覧できるリポジトリを Alfred から検索し、選択したリポジトリを既定のブラウザで開くワークフローです。

## 使い方

Alfred で `gh` に続けて、所有者名またはリポジトリ名の一部を入力します。検索は大文字小文字を区別せず、文字列の任意の位置に一致します。

検索対象には、次のリポジトリが含まれます。

- 自分が所有するリポジトリ
- 共同作業者として参加しているリポジトリ
- 所属Organizationを通じて閲覧できるリポジトリ

GitHub 全体のリポジトリやスター済みリポジトリは検索しません。

## 要件

- macOS 13以降
- Alfred 5
- Alfred Powerpack
- [GitHub CLI](https://cli.github.com/) 2.60.0以降

GitHub CLI は Homebrew または MacPorts の標準配置にインストールしてください。

## 認証

ワークフローは `gh auth status` で GitHub.com のアクティブなアカウントを確認します。未認証の場合は `Sign in to GitHub` を選択し、Terminal で GitHub CLI のWeb認証を完了してください。認証コードのクリップボード書込やSSH鍵の生成・アップロードは行いません。

環境変数だけで認証している構成や独自の `GH_CONFIG_DIR` には対応せず、標準の `gh auth login` による認証が必要です。Organization の設定によっては、GitHub CLI OAuth App の承認や SAML SSO認証が別途必要です。

## データの取扱い

リポジトリ一覧は認証状態を確認した後に `gh api` で取得し、ディスクへ保存しません。アクセストークンも直接読み取り、保存、表示しません。

GitHub CLI は配置先と実体を検証し、Alfred の非公開キャッシュへ安全に複製した実行ファイルを使用します。親プロセスのトークン、プロキシ、ブラウザ、`PATH` などの環境変数は引き継ぎません。

所有者のアバターは GitHub のHTTPSホストから直接取得し、当該ワークフロー専用キャッシュへ非公開権限で保存します。画像は7日後に更新し、取得できない場合も検索結果は通常どおり表示します。

リポジトリ共通のセキュリティ方針は [SECURITY.md](../../SECURITY.md) を参照してください。

## 開発

検査、Universal Binary のビルド、パッケージ作成はリポジトリルートで実行します。

```sh
mise run check
mise run build
mise run package
```

生成物は次のとおりです。

```text
build/github-repositories
dist/github-repositories-<version>.alfredworkflow
dist/github-repositories-<version>.alfredworkflow.sha256
```

ビルド時のネットワークアクセスと親プロセスの言語設定は無効化されます。開発用実行ファイルにはad-hocコード署名を行い、配布物のZIP内容、アーキテクチャ、署名、SHA-256チェックサムをパッケージ作成時に検証します。
