# Alfred Workflows

[Alfred 5](https://www.alfredapp.com/) 向けの複数のワークフローを、1つのリポジトリで実装・管理します。

## ワークフロー一覧

| ワークフロー | キーワード | 概要 |
| --- | --- | --- |
| [GitHub Navigator](workflows/github-repositories/README.md) | `gh` | GitHubのリポジトリとProjectを検索し、IssuesとPull requestsを開く |

使い方、追加要件、認証、生成物などの詳細は、各ワークフローの README を参照してください。

## 共通要件

- macOS 13以降
- Alfred 5
- Alfred Powerpack

ワークフロー固有のCLIやサービスは、各ワークフローの追加要件として管理します。

## インストール

GitHub Releases から目的のワークフローの `.alfredworkflow` をダウンロードし、ダブルクリックして Alfred へ読み込みます。各ワークフローは独立した配布物として提供します。

## リポジトリ構成

```text
cmd/          ワークフローに同梱する実行ファイル
internal/     ワークフローごとの内部実装
scripts/      共通またはワークフロー固有の開発スクリプト
workflows/    Alfred定義とワークフロー別README
```

ワークフローの識別子には一貫した短い名前を使用し、関連する実装、Alfred定義、配布物の対応関係を明確にします。

## 開発環境

言語とツールのバージョンは [mise](https://mise.jdx.dev/) で管理します。

```sh
mise install
```

開発者固有の設定には、Git の管理対象外である `mise.local.toml` を使用します。現在、リポジトリルートから次のタスクを実行できます。

```sh
mise run check
mise run build
mise run package
```

タスクの対象や生成物は、各ワークフローの README に記載します。新しい言語やツールチェーンを追加する場合も、バージョンは mise で固定します。

## 管理方針

- ワークフローごとにAlfred定義、実装、ドキュメント、配布物を分離する
- Alfredの個人設定を保存する `prefs.plist` はコミットしない
- APIキーなどの秘密情報をワークフローやリポジトリへ保存しない
- 共有するワークフローでは、利用者固有の絶対パスを埋め込まない
- ワークフロー固有の要件や制約は、該当ディレクトリの README へ記載する

## セキュリティ

リポジトリ共通の信頼境界、実装方針、脆弱性の報告方法は [SECURITY.md](SECURITY.md) を参照してください。

## 配布

配布物はワークフロー単位でバージョン管理し、GitHub Releases へ添付します。実行ファイルを必要とするワークフローでは Universal Binary を同梱し、利用者側の言語ランタイムや mise への依存を避けます。

開発用パッケージにはSHA-256チェックサムを生成します。ただし、チェックサムやad-hocコード署名だけでは配布者の本人性を証明できません。公開リリースまでに、認証済み署名または同等の署名付きprovenanceを配布経路へ設定します。

## ライセンス

[MIT License](LICENSE)
