# GitHub Navigator

GitHub CLI のアクティブなアカウントを使い、GitHubのリポジトリとProjectをAlfredから検索するワークフローです。IssuesとPull requestsの個人向け一覧も直接開けます。

## 使い方

Alfredで`gh`に続けて入力します。

| 入力 | 動作 |
| --- | --- |
| `gh` | 閲覧可能なリポジトリを一覧表示する |
| `gh <テキスト>` | 所有者名またはリポジトリ名を部分一致で絞り込む |
| `gh issue` / `gh issues` | [GitHub Issues](https://github.com/issues)を開く |
| `gh pr` / `gh prs` | [GitHub Pull requests](https://github.com/pulls)を開く |
| `gh project` / `gh projects` | 閲覧可能なOpen Projectを一覧表示する |
| `gh project <テキスト>` / `gh projects <テキスト>` | 所有者名またはProject名を部分一致で絞り込む |

検索は大文字小文字を区別せず、文字列の任意の位置に一致します。IssuesとPull requestsの入力は完全一致の場合だけ固定リンクとして扱います。

## 検索対象

リポジトリ検索には、次のリポジトリが含まれます。

- 自分が所有するリポジトリ
- 共同作業者として参加しているリポジトリ
- 所属Organizationを通じて閲覧できるリポジトリ

Project検索には、自分または所属Organizationが所有し、アクティブなアカウントが閲覧できるOpen Projectが含まれます。取得件数は所有者ごとに最大100件です。Closed Project、GitHub全体のリポジトリ、スター済みリポジトリは検索しません。

## 要件

- macOS 13以降
- Alfred 5
- Alfred Powerpack
- [GitHub CLI](https://cli.github.com/) 2.60.0以降

GitHub CLI はHomebrewまたはMacPortsの標準配置にインストールしてください。IssuesとPull requestsの固定リンクだけは、GitHub CLIが未導入または未認証でも利用できます。

## 認証

ワークフローは`gh auth status`でGitHub.comのアクティブなアカウントを確認します。未認証の場合は表示された`Sign in to GitHub`を選択し、TerminalでGitHub CLIのWeb認証を完了してください。認証コードのクリップボード書込やSSH鍵の生成・アップロードは行いません。

Project検索には、GitHub CLI OAuth Appの`read:project`スコープが必要です。

- 未認証の場合は`Sign in to GitHub for Projects`から、Project読取権限を含むWeb認証を開始する
- 認証済みで権限が不足する場合は`Authorize GitHub Projects`から、既存認証へ`read:project`だけを追加する

Projectの書込権限は要求しません。Organizationの設定によっては、GitHub CLI OAuth Appの承認やSAML SSO認証が別途必要です。

環境変数だけで認証している構成や独自の`GH_CONFIG_DIR`には対応せず、標準の`gh auth login`による認証が必要です。

## データの取扱い

リポジトリ一覧とProject一覧は認証状態を確認した後に`gh api`で取得し、ディスクへ保存しません。アクセストークンも直接読み取り、保存、表示しません。

Project一覧は固定したGraphQLクエリで取得します。Alfredへ入力した検索テキストはGitHub APIへ送信せず、取得後にワークフロー内で照合します。GitHubから返された遷移先も検証し、GitHub.com上の対象リポジトリまたはProject URLだけを開きます。

GitHub CLIは配置先と実体を検証し、Alfredの非公開キャッシュへ安全に複製した実行ファイルを使用します。親プロセスのトークン、プロキシ、ブラウザ、`PATH`などの環境変数は引き継ぎません。

所有者のアバターはGitHubのHTTPSホストから直接取得し、当該ワークフロー専用キャッシュへ非公開権限で保存します。画像は7日後に更新し、取得できない場合も検索結果は通常どおり表示します。

リポジトリ共通のセキュリティ方針は[SECURITY.md](../../SECURITY.md)を参照してください。

## 開発

検査、Universal Binaryのビルド、パッケージ作成はリポジトリルートで実行します。

```sh
mise run check
mise run build
mise run package
```

生成物は次のとおりです。互換性のため、配布物名はGitHub Navigatorへの改称後も維持します。

```text
build/github-repositories
dist/github-repositories-<version>.alfredworkflow
dist/github-repositories-<version>.alfredworkflow.sha256
```

ビルド時のネットワークアクセスと親プロセスの言語設定は無効化されます。開発用実行ファイルにはad-hocコード署名を行い、配布物のZIP内容、アーキテクチャ、署名、SHA-256チェックサムをパッケージ作成時に検証します。
