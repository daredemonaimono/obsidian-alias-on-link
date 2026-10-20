# Alias on Link

`[[ノート|別名]]` とリンクに別名を付けると、リンク先ノートのフロントマターの `aliases` に自動で別名を追加する Obsidian プラグインです。

- リンク先にフロントマターが無ければ、フロントマターと `aliases` を作って別名を入れます。
- フロントマターはあるが `aliases` が無ければ、`aliases` を作って別名を入れます。
- `aliases` があれば、別名を追加するだけです（重複は追加しません）。
- 編集が止まって約2秒後に反映します。
- `[[ノート#見出し|別名]]` はノート本体が対象です。自分自身へのリンク、存在しないノート、別名がノート名と同じ場合は何もしません。
- 注意: 追加時に Obsidian の標準機能でフロントマターを書き換えるため、リンク先の YAML の書式が整形されることがあります。

## BRAT でのインストール

1. Obsidian に BRAT プラグインを入れる。
2. BRAT の「Add Beta plugin」に `daredemonaimono/obsidian-alias-on-link` を入力する。
3. 設定の Community plugins で「Alias on Link」を有効にする。

## ビルド

```bash
npm install
npm run build   # main.js が生成される
```

## リリース

`manifest.json` の version と同じタグでリリースを作り、`main.js` と `manifest.json` を添付します。
