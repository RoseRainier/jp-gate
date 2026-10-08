# pi-jp-correct

[Pi](https://pi.dev/) の回答本文を、表示・保存する前に別の LLM（Gate モデル）で日本語に補正する拡張です。混ざった英語・中国語・韓国語を日本語にし、誤字や不自然な表現を整えます。

```text
メインモデル → 回答本文を保持 → Gate モデルで日本語を補正 → Pi が表示・保存
```

内容・意図、コード、URL、数式、Markdown の構造を維持するようモデルに指示します。ツール呼び出しの引数とメインモデルの thinking は変更しません。

## 動作環境

- Node.js 22.19.0 以降
- Pi 1.0.2 以降の 1.x（`@earendil-works/pi-coding-agent` / `@earendil-works/pi-ai` 1.0.2 で検証）
- Pi に登録され、認証済みの Gate 用モデル

## インストール

Pi をまだ導入していない場合は、[公式の手順](https://pi.dev/docs/latest/quickstart)に従ってインストールしてください。npm を使う場合は次のコマンドで導入できます。

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
pi --version
```

この拡張をインストールします。

```bash
pi install git:github.com/RoseRainier/jp-gate
```

インストール後は Pi の起動時に自動で読み込まれます。TypeScript を直接読み込むため、手動のビルドは不要です。

特定のプロジェクトだけで使う場合は、そのディレクトリで次を実行します。プロジェクト設定の読み込みには Pi 側でプロジェクトを信頼する必要があります。

```bash
pi install -l git:github.com/RoseRainier/jp-gate
```

## 使い方

### Gate モデルを指定して起動する

初回は Pi を起動して `/login` から利用するプロバイダーの認証を済ませてください。環境変数による API キー設定なども利用できます。詳しくは [Pi のモデル・認証設定](https://pi.dev/docs/latest/models)を参照してください。

補正は既定で ON ですが、Gate 用モデルは未設定です。利用できるモデルを確認し、`provider/model-id` 形式で指定します。

```bash
pi --list-models
pi --jp-gate on --jp-gate-model openai/gpt-4.1-mini
```

`openai/gpt-4.1-mini` は設定例です。利用できるモデルに置き換えてください。認証には Pi のプロバイダー設定・API キー・OAuth を利用します。この拡張の設定ファイルに API キーは書きません。

メインモデルは通常どおり Pi の `/model` または `--model` で選択します。`--jp-gate-model` は補正用モデルだけを指定するため、メインモデルと別のモデルを使えます。

### 対話中に操作する

| コマンド | 動作 |
| --- | --- |
| `/jp-gate on` | 補正を有効化 |
| `/jp-gate off` | 補正を無効化 |
| `/jp-gate status` | ON/OFF、モデル、読み込んだ設定ファイルを表示 |
| `/jp-gate model provider/model-id` | Gate モデルを変更 |
| `/jp-gate reload` | 設定ファイルと起動時の CLI 指定を再読み込み |

対話コマンドによる変更は現在のセッションだけに有効です。次回以降も使う設定は、以下の設定ファイルに保存してください。

### 起動時に OFF にする

```bash
pi --jp-gate off
```

OFF 時は Gate モデルを呼ばず、通常のストリーミング出力を使います。

### 非対話モードで使う

対話モードと同じ設定で、print モードや JSON モードでも補正できます。

```bash
pi --jp-gate on --jp-gate-model openai/gpt-4.1-mini -p "このプロジェクトの構成を説明してください。"
pi --jp-gate on --jp-gate-model openai/gpt-4.1-mini --mode json -p "このプロジェクトの構成を説明してください。"
```

JSON モードでは、補正後の本文を含む Pi の JSON イベントを出力します。Gate モデルに渡すのは本文の文字列だけです。

## プロンプトを編集する

編集用プロンプトは **Markdown ファイル** です。全体用の保存場所は `~/.pi/agent/jp-gate-prompt.md` で、拡張パッケージの外にあるため `pi update` で上書きされません。`PI_CODING_AGENT_DIR` を指定している場合は、そのディレクトリー内を使います。

全体用プロンプトを初めて使う際、ファイルがなければ同梱の [prompts/jp-gate.md](prompts/jp-gate.md) をコピーして作成します。既存のファイルは起動・再読み込み時にも上書きしません。以後はこの編集用 Markdown を変更し、`/jp-gate reload` で反映できます。

| 適用範囲 | ファイル／指定方法 |
| --- | --- |
| 全体用 | `~/.pi/agent/jp-gate-prompt.md` |
| 作業ディレクトリー用 | `<cwd>/.pi/jp-gate-prompt.md` を作成 |
| 任意のファイル | `gate.promptFile` または `--jp-gate-prompt <path>` で指定 |

プロンプトの選択順は、優先度の高い順に **CLI の `--jp-gate-prompt` → 設定の `gate.promptFile` → 作業ディレクトリーの Markdown → 全体用 Markdown** です。設定ファイル間の `gate.promptFile` の優先順位は、ほかの設定項目と同じです。明示指定した相対パスは、JSON 設定・CLI ともに起動時の `<cwd>` を基準に解決します。

任意のファイルを設定する例:

```json
{
  "gate": {
    "promptFile": "/absolute/path/to/my-jp-gate-prompt.md"
  }
}
```

`pi --jp-gate-prompt ./my-prompt.md` と起動時に指定することもできます。更新後も保持したい編集用ファイルは、拡張のインストール先の外に保存してください。同梱の `prompts/jp-gate.md` は初期テンプレートで、パッケージ更新の対象になりますが、その変更を既存の編集用ファイルへ自動反映することはありません。

Markdown の内容全体を、そのまま Gate の system prompt として渡します。TypeScript の宣言や文字列の囲みは不要です。旧 `src/gate-prompt.ts` を直接編集していた場合は、更新前にその指示本文を外部 Markdown へ移してください。

存在しない明示指定ファイル、読めないファイル、空のプロンプトはエラーにします。別のプロンプトへの切り替えや上書きは行いません。OFF 時にはプロンプトを読み込まず、`/jp-gate on` で有効化するときに読み込みます。

## 設定ファイル

毎回モデルを指定せずに使う場合は、次のいずれかの場所に `jp-gate.json` を作成します。

| 保存先 | 適用範囲 |
| --- | --- |
| `~/.pi/agent/jp-gate.json` | 全プロジェクト |
| 作業ディレクトリの `.pi/jp-gate.json` | そのプロジェクト |

`PI_CODING_AGENT_DIR` を設定している場合、全体設定はそのディレクトリの `jp-gate.json` から読み込みます。

```json
{
  "enabled": true,
  "gate": {
    "model": "openai/gpt-4.1-mini",
    "timeoutMs": 60000,
    "maxTokens": 8192,
    "temperature": 0
  },
  "failureMode": "block"
}
```

設定例は [examples/jp-gate.json](examples/jp-gate.json) にもあります。保存後は `pi` だけで起動できます。起動中の Pi には `/jp-gate reload` で反映してください。

| 項目 | 既定値 | 意味 |
| --- | --- | --- |
| `enabled` | `true` | 日本語補正の ON/OFF（既定で ON） |
| `gate.model` | 未指定 | `provider/model-id` 形式の補正用モデル。ON 時に本文を補正するために必須 |
| `gate.promptFile` | 自動選択 | カスタム Markdown プロンプトのパス |
| `gate.timeoutMs` | `60000` | Gate 呼び出しの待機上限（ミリ秒） |
| `gate.maxTokens` | `8192` | 補正結果の出力トークン上限 |
| `gate.temperature` | `0` | Gate モデルの temperature |
| `failureMode` | `block` | 補正失敗時の動作。`block` または `passthrough` |

別の設定ファイルを指定することもできます。

```bash
pi --jp-gate-config ./my-settings.json
```

設定の優先順位は、低い順に **既定値 → 全体設定 → プロジェクト設定 → 明示した設定ファイル → CLI** です。各ファイルには変更したい項目だけを書けます。起動時に CLI で指定した値は、`/jp-gate reload` 後も優先されます。

モデル指定は最初の `/` で分割するため、`openrouter/vendor/model-id` のようなモデル ID も使えます。

## 動作と注意点

- ON 時は、日本語だけの文章も含め、本文のあるモデル応答ごとに補正します。ツール実行前の説明文も対象です。空の本文と、本文のないツール呼び出しはそのまま通します。
- 本文を保持してから補正するため、Gate の待ち時間と API 利用料が加わります。補正前の本文は Pi の通常出力やセッション履歴に流しません。
- Gate に渡すのは回答本文だけです。本文が複数ある場合は一つずつ補正します。会話履歴、メインモデルの system prompt、thinking、ツールの定義・引数は渡しません。
- 内容や書式の維持は LLM への指示で行います。原文との一致をプログラムで保証するものではなく、補正品質は指定したモデルに依存します。
- 英語などを意図的に出力したい場合や、本文を機械処理用の JSON として使う場合は OFF にしてください。
- Gate の使用量はセッションの `jp-gate-usage` に別途記録します。Pi の通常の使用量表示には Gate のトークン数・料金を合算しません。

補正がタイムアウトした場合や、空の結果・出力上限による途中終了・異常終了・Gate からのツール呼び出しがあった場合は、`failureMode` に従って処理します。

| 設定 | 補正失敗時の動作 |
| --- | --- |
| `block`（既定） | 未補正の本文を出さず、その応答に含まれるツール呼び出しも実行しない |
| `passthrough` | 警告を出し、元の応答を出力する |

中断操作は Gate にも伝わります。中断時は `passthrough` 設定でも元の応答を出力しません。

## 更新・アンインストール

最新版へ更新する場合:

```bash
pi update git:github.com/RoseRainier/jp-gate
```

更新後は Pi を再起動して反映してください。`/jp-gate reload` は設定の再読み込み用です。プロジェクト単位でインストールした場合は、そのディレクトリで更新します。

アンインストールする場合:

```bash
pi remove git:github.com/RoseRainier/jp-gate
```

プロジェクト単位のインストールを削除する場合は、`pi remove -l git:github.com/RoseRainier/jp-gate` を使います。

## ローカル開発・検証

```bash
git clone https://github.com/RoseRainier/jp-gate.git
cd jp-gate
npm ci
pi -e ./extensions/jp-correct.ts --jp-gate on --jp-gate-model openai/gpt-4.1-mini
```

ローカルのパッケージを継続して読み込む場合は、`pi install /absolute/path/to/jp-gate` で登録できます。

```bash
npm run check
npm pack --dry-run
```

`npm run check` は型チェック、ユニットテスト、実際の Pi CLI を使う結合テストを実行します。結合テストは模擬モデルを使うため、外部 API 呼び出しや認証情報は不要です。

補正用プロンプトは外部 Markdown で編集し、`/jp-gate reload` で反映できます。同梱の初期テンプレートは [prompts/jp-gate.md](prompts/jp-gate.md) です。

## ライセンス

[Apache License 2.0](LICENSE)
