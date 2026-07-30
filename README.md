# Alfred Workflows

[Alfred 5](https://www.alfredapp.com/) 向けワークフローを実装・管理するリポジトリです。

## 要件

- macOS 13以降
- Alfred 5
- Alfred Powerpack

## 開発環境

実装言語には Go を使用し、ツールのバージョンは [mise](https://mise.jdx.dev/) で管理します。

```sh
mise install
```

開発者固有の設定には、Git の管理対象外である `mise.local.toml` を使用します。

## 管理方針

- Alfred の個人設定を保存する `prefs.plist` はコミットしない
- APIキーなどの秘密情報をワークフローやリポジトリへ保存しない
- 共有するワークフローでは、利用者固有の絶対パスを使用しない

## 配布

ワークフローのソースはリポジトリで管理し、配布用の `.alfredworkflow` は GitHub Releases へ添付します。Apple Silicon と Intel に対応する実行ファイルを同梱するため、利用者による Go や `mise` のインストールは不要です。

## ライセンス

[MIT License](LICENSE)
