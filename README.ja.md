![MCP for After Effects](https://raw.githubusercontent.com/kumoproductions/mcp-aftereffects/main/assets/ogp.png)

# mcp-aftereffects

[English](./README.md) | 日本語

Adobe After Effects を AI から操作できるようにする MCP サーバーです。

Claude Code や Claude Desktop などの MCP 対応クライアントから、起動中の After Effects に接続し、プロジェクトの確認・編集・レンダリングまでを AI に任せることができます。

After Effects の操作方法を細かく指示する必要はありません。
やりたいことを自然な言葉で伝えるだけで、AI がプロジェクトの状態を確認し、必要な操作を行います。

**Windows / macOS · After Effects 2024–2026 · Node.js 24+**

> [!CAUTION]
> **このツールは After Effects のプロジェクトを AI から直接操作します。**
>
> AI はプロジェクトの内容を読み取ったり、コンポジション、レイヤー、エフェクト、キーフレームなどを変更したりできます。
>
> また、AI がプロジェクトから読み取った情報は、使用している AI サービスへ送信される場合があります。コンポジション名、レイヤー名、エクスプレッション、キーフレーム、フッテージのファイルパスなどが含まれる可能性があります。
>
> NDA のある案件や未公開作品で使用する場合は、使用する AI サービスのデータ保持ポリシーや MCP クライアントのログについて、事前に確認してください。
>
> 初めて使用する場合は、重要なプロジェクトではなく、バックアップまたはテスト用の `.aep` ファイルから試すことをおすすめします。

## できること

mcp-aftereffects を使うと、AI に After Effects の作業を依頼できます。

- プロジェクトの内容を確認する
- コンポジションやレイヤーを調査する
- レイヤーやプロパティを編集する
- キーフレームを追加・変更する
- エフェクトやマスクを編集する
- テキストやシェイプを編集する
- エクスプレッションを設定する
- プロジェクトを保存する
- プロジェクトのバックアップを作成・復元する
- フレームをレンダリングして変更結果を確認する

たとえば、次のような指示ができます。

> 「このIllustratorファイルをインポートして、いい感じにテキストモーションを作成して」

> 「このPDFの修正内容をやっておいて」

> 「このAEPの問題点を指摘して」

複雑な作業でも、AI がプロジェクトの状態を確認しながら必要な操作を組み合わせて実行できます。

## 動作要件

- Windows または macOS
- Adobe After Effects 2024 / 2025 / 2026
- Node.js 24 以上
- MCP 対応クライアント（Claude Code、Claude Desktop など）

After Effects を 1 つだけ動かす通常の使い方では、After Effects 側にプラグインやパネルをインストールする必要はありません。複数のインスタンスを同時に扱う場合（`AfterFX.exe -m`）だけ、小さな起動スクリプトが必要です。[複数の After Effects インスタンスを扱う](#複数の-after-effects-インスタンスを扱う) を参照してください。

### After Effects の設定

After Effects の環境設定で、以下を ON にしてください。

**環境設定 → スクリプトとエクスプレッション →「スクリプトによるファイルへの書き込みとネットワークへのアクセスを許可」**

この設定が OFF の場合、AI からの操作が正常に実行できません。

### macOS の場合

初回利用時に、macOS が After Effects の操作許可を求める場合があります。

許可されていない場合は、

**システム設定 → プライバシーとセキュリティ → オートメーション**

から、使用している MCP クライアントまたはターミナルによる After Effects の操作を許可してください。

## クイックスタート

After Effects を 1 つだけ動かす限り、After Effects 側へのインストールは不要です。

まず After Effects を起動して、操作したいプロジェクトを開いてください。

その後、使用している MCP クライアントに mcp-aftereffects を登録します。

### Claude Code

```bash
claude mcp add aftereffects -- npx -y @kumoproductions/mcp-aftereffects
```

### Claude Desktop

MCP の設定ファイルに以下を追加します。

```json
{
  "mcpServers": {
    "aftereffects": {
      "command": "npx",
      "args": ["-y", "@kumoproductions/mcp-aftereffects"]
    }
  }
}
```

その他の MCP クライアントを使用する場合は、それぞれの MCP サーバー登録方法に従ってください。

### 読み取り専用モード

プロジェクトを変更させずに、内容の確認や監査だけを行いたい場合は、読み取り専用モードを利用できます。

MCP クライアントの設定に以下を追加します。

```json
{
  "mcpServers": {
    "aftereffects": {
      "command": "npx",
      "args": ["-y", "@kumoproductions/mcp-aftereffects"],
      "env": {
        "AE_MCP_READONLY": "1"
      }
    }
  }
}
```

プロジェクトの調査やレンダリングによる確認は引き続き利用できます。

## 高度な設定

通常は設定する必要はありません。

After Effects が標準とは異なる場所にインストールされている場合など、一部の環境では追加の設定が必要になる場合があります。

### After Effects の場所を指定する

After Effects が標準のインストール場所にない場合は、`AE_MCP_EXE` で実行ファイルの場所を指定できます。

通常は After Effects 2026 → 2025 → 2024 の順に自動で検索されます。

### 操作範囲を制限する

`AE_MCP_ALLOW_CATEGORIES` を使用すると、AI に許可する操作の種類を制限できます。

たとえば、キーフレーム関連の操作だけを許可するなど、用途に応じて権限を絞ることができます。

### 複数の After Effects インスタンスを扱う

After Effects は `AfterFX.exe -m` で複数同時に起動でき、それぞれが別のプロジェクトを持てます。標準の状態では、サーバーが届くのは通常起動した最初の 1 つだけです。`-m` で起動したインスタンスには、サーバーが送るスクリプトが一切届きません。これらを扱うには、常駐エージェントを一度インストールします。

```bash
npx @kumoproductions/mcp-aftereffects install-agent
```

After Effects のユーザー単位の `Scripts/Startup` フォルダに小さな起動スクリプトが置かれます（管理者権限は不要です。After Effects をアップデートしたら再度実行してください）。次回起動から、`-m` のものも含めてすべてのインスタンスが自分専用のメールボックスを持ち、サーバーはどのインスタンスと話すかを選べるようになります。

- サーバーの `env` に `AE_MCP_INSTANCE` を設定すると、そのセッションの既定のインスタンスになります。起動時に付けた ID か、開いているプロジェクトファイル（`"shotA"`、`"shotA.aep"`、同名プロジェクトが複数あるならフルパス）で指定します。
- すべてのツールに省略可能な `instance` 引数があり、1 回の呼び出しだけ別のインスタンスに向けられます。
- `ae_context` と `ae_do instance.list` で、動いているインスタンスを確認できます。

起動時にインスタンスへ名前を付けるには、起動する環境で `AE_MCP_INSTANCE` を設定します。

```bat
set AE_MCP_INSTANCE=shotA
"C:\Program Files\Adobe\Adobe After Effects 2026\Support Files\AfterFX.exe" -m
```

名前を付けなかったインスタンスにはランダムな ID（`ae-…`）が付きますが、プロジェクトファイル名で指定できます。動いているエージェントが 1 つだけなら設定は不要です。複数動いていて名前の指定がない場合は、推測せずに `NO_INSTANCE` エラーになります。

エージェントは After Effects が動いている間ずっとメールボックスを監視し続けます。サーバーが動いていなくても同じです。そのため、ユーザー単位の一時フォルダにあるメールボックスのディレクトリが、セッション全体を通じて信頼境界になります。メールボックスの場所はインストール時に起動スクリプトへ固定されます。`AE_MCP_RUNTIME_DIR` を変えた場合は `install-agent` を再実行してください（`agent-status` で古くなっているか確認できます）。

### ワーカーインスタンスで並列作業する

AI 自身がインスタンスを起動できます。`instance.start` は新しい After Effects を起動して登録を待ち、プロジェクト、またはその**コピー**を開けます。メインのインスタンスが開いているプロジェクトを安全に扱うには、コピーを使います。

1. `instance.start { name: "w1", copyFrom: "<メインの .aep>" }` でコピーを持ったワーカーを起動
2. `instance: "w1"` を付けて任意のツールで作業
3. `instance: "w1"` を付けて `ae_save_project`
4. メインのインスタンスで `project.merge { path: "<コピー>" }`。コピーがフォルダとして取り込まれ、既存の項目には触れません
5. `instance.stop { name: "w1" }`

ワーカーは複数同時に動かせます。それぞれが本物の After Effects なので、1 インスタンスあたり数 GB のメモリを見込んでください。

## 任意の ExtendScript の実行について

mcp-aftereffects には、通常の操作では対応できない処理のために、任意の ExtendScript を実行できる高度な機能があります。

この機能は **デフォルトでは無効**になっています。

> [!CAUTION]
> **任意の ExtendScript を有効にすると、After Effects の外部に対しても操作できるようになります。**
>
> ファイルやプロセスの操作など、**コンピューター全体に影響する処理を実行できる可能性があります。**
>
> この機能はデフォルトでは無効になっています。必要な場合のみ有効にしてください。

有効化するには、MCP サーバーの環境変数に以下を設定します。

```json
"env": {
  "AE_MCP_ENABLE_EVAL": "1"
}
```

この機能は、通常の操作では実現できない高度な処理や、独自の ExtendScript が必要な場合にのみ使用してください。

## 公式リリース

> [!NOTE]
> **公式のリリース物は npm と GitHub Releases からのみ配布されます。**
>
> `@kumoproductions/mcp-aftereffects` を名乗るパッケージや、このサーバーを名乗るファイルを、それ以外の場所から入手する場合は注意してください。

## トラブルシューティング

### 操作がタイムアウトする

以下を確認してください。

- After Effects が起動しているか
- プロジェクトが開かれているか
- 「スクリプトによるファイルへの書き込みとネットワークへのアクセスを許可」が ON になっているか
- macOS の場合、オートメーションの許可が有効になっているか

### `NO_INSTANCE` になる

呼び出しの宛先になる After Effects がありません。動いている After Effects がすべて `-m` 起動でエージェント未インストール（[複数の After Effects インスタンスを扱う](#複数の-after-effects-インスタンスを扱う) を参照）、`AE_MCP_INSTANCE` や `instance` で指定したインスタンスが動いていない、あるいはダイアログで止まっている、複数のエージェントが動いていて名前の指定がない、のいずれかです。エラーに動いているインスタンスの一覧が出ます。

### After Effects が「クラッシュを検出しました」のダイアログで止まる

After Effects のプロセスを強制終了（タスクマネージャー、`taskkill`、クラッシュ）すると、次の起動でセーフモードのダイアログが出てクリックを待ちます。`instance.start` で起動したインスタンスも同じで、`did not register` で失敗します。画面上でダイアログを閉じてください。通常終了したインスタンスではこのダイアログは出ないので、強制終了ではなく `instance.stop` を使ってください。

### After Effects が見つからない

After Effects を標準とは異なる場所にインストールしている場合は、`AE_MCP_EXE` を設定してください。

それでも解決しない場合は、Issue または @cumuloworks まで報告してください。

## 開発者向け情報

内部の MCP ツール、After Effects との通信方式、ExtendScript、テスト環境、独自の操作を追加する方法などについては、開発者向けドキュメントを参照してください。

- `docs/TOOLS.md`
- `CONTRIBUTING.md`

## Contributing

バグ報告、機能要望、Pull Request を歓迎します。

開発環境の構築方法や内部アーキテクチャについては `CONTRIBUTING.md` を参照してください。

## License

MIT © 2026 kumo.productions, Inc.

## Trademark

Adobe® および Adobe After Effects® は Adobe Inc. の商標です。

本プロジェクトは独立した非公式のツールであり、**Adobe が提携・承認したものではありません**。
