# pi-jp-correct

Pi の回答に混ざった英語・中国語・韓国語だけを、表示前に **専用の Gate LLM** で日本語にする拡張です。
問題のない文章は変更せず、それ以外の表現・語順・助詞・文体を維持するよう指示します。言語の判定や日本語への書き換えにルールベースの置換は使いません。

```text
メインモデル → 応答を保持 → Gate LLM が混入した英語・中国語・韓国語を日本語化 → Pi が出力・保存
```

コード・URL はプログラム側でマスクし、校正後に元の文字列を戻します。ツール呼び出しの引数と thinking は変更しません。

## 動作環境

- Node.js 22.19 以降
- Pi 1.x（`@earendil-works/pi-coding-agent` / `@earendil-works/pi-ai` 1.0.2 で検証）
- Pi に登録され、認証済みの Gate 用モデル

Pi の公式 [拡張 API](https://pi.dev/docs/latest/extensions) と [Provider API](https://pi.dev/docs/latest/custom-provider) を使います。旧 `@mariozechner/*` パッケージは対象外です。

## 起動

開発用の依存関係をインストールして、拡張を直接読み込めます。

```bash
npm ci
pi -e ./extensions/jp-correct.ts \
  --jp-gate on \
  --jp-gate-model openai/gpt-4.1-mini
```

`openai/gpt-4.1-mini` は設定例です。利用できるモデルに置き換えてください。メインモデルは Pi で選択したモデルのままです。Gate 用モデルはメインと別のものを指定できます。

Gate の認証には Pi のプロバイダー設定・API キー・OAuth を利用します。この拡張の設定ファイルに API キーは書きません。登録モデルの確認には `pi --list-models` を使えます。

ローカルの Pi パッケージとしてインストールする場合:

```bash
pi install /absolute/path/to/jp_correct
pi --jp-gate on --jp-gate-model openai/gpt-4.1-mini
```

Git に公開した後は、Pi の `pi install git:...` 形式でもインストールできます。TypeScript を直接読み込むのでビルドは不要です。

## ON / OFF

CLI で切り替えます。値は `on` / `off` です。

```bash
pi -e ./extensions/jp-correct.ts --jp-gate on --jp-gate-model openai/gpt-4.1-mini
pi -e ./extensions/jp-correct.ts --jp-gate off
```

対話中には次のコマンドを使えます。

| コマンド | 動作 |
| --- | --- |
| `/jp-gate on` | 補正を有効化 |
| `/jp-gate off` | 補正を無効化 |
| `/jp-gate status` | 現在のモデル・設定・ON/OFF を表示 |
| `/jp-gate model provider/model-id` | Gate モデルを変更 |
| `/jp-gate reload` | 設定ファイルと起動時の CLI 指定を再読み込み |

対話コマンドによる変更は現在のセッション内で有効です。永続化したい場合は設定ファイルを編集してください。

## 設定ファイル

全プロジェクトで使う場合は `~/.pi/agent/jp-gate.json`、プロジェクト単位では作業ディレクトリーの `.pi/jp-gate.json` を作成します。Pi の設定ディレクトリーを `PI_CODING_AGENT_DIR` で変更している場合は、そのディレクトリーを使います。

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

`"enabled": false` で OFF になります。設定例は [examples/jp-gate.json](examples/jp-gate.json) にあります。

別のファイルを明示することもできます。

```bash
pi -e ./extensions/jp-correct.ts --jp-gate-config ./my-settings.json
```

設定の優先順位は、低い順に **既定値 → 全体設定 → プロジェクト設定 → 明示した設定ファイル → CLI** です。各ファイルには変更したい項目だけを書けます。ファイルの編集後は `/jp-gate reload` または Pi の再起動で反映します。

| 項目 | 既定値 | 意味 |
| --- | --- | --- |
| `enabled` | `true` | 日本語補正の ON/OFF |
| `gate.model` | 未指定 | `provider/model-id`。ON で説明文を補正する場合に必須 |
| `gate.timeoutMs` | `60000` | Gate 呼び出しの待機上限（ミリ秒） |
| `gate.maxTokens` | `8192` | 校正結果の出力トークン上限。長文では増やす |
| `gate.temperature` | `0` | Gate モデルの temperature |
| `failureMode` | `block` | `block` または `passthrough` |

`provider/model-id` は最初の `/` で分割するため、`openrouter/vendor/model-id` のようなモデル ID も使えます。

## 補正とエラーの扱い

- ON 時は説明文を常に Gate LLM に渡します。英語・中国語・韓国語だけを日本語にし、問題のない文章は変更しないよう指示します。日本語だけの文章も確認対象です。コードや URL だけの文章、本文のないツール呼び出しはそのまま通します。
- メインモデルのストリームを保持し、校正後に通常の Pi ストリームとして出力します。補正前の本文は TUI・print・JSON・RPC の通常出力やセッション履歴へ流しません。
- Gate に渡すのはマスク済みの回答本文です。会話履歴、メインモデルの system prompt、thinking、ツールの定義・引数は渡しません。
- Markdown のコードフェンス、インラインコード、インデントされたコード、URL、リンク先、HTML タグは原文を保持します。本文の見出しやリストなどは LLM に構造維持を指示します。
- 校正結果の JSON 形式・本文の個数・保護マーカーを検証します。空の結果、出力上限による途中終了、保護マーカーの欠落・重複・順序変更は失敗として扱います。
- 本文が改行位置で複数の配列要素に分かれただけで、全要素の内容・順序が原文と完全に一致する場合は、原文の改行と要素構造を復元します。分割された本文に翻訳・変更・欠落がある場合は失敗として扱い、推測で結合しません。
- `block` では失敗時に未補正の本文を出しません。その応答に含まれるツール呼び出しも実行しません。`passthrough` を明示した場合は、失敗時に警告を出し、元の応答を出力します。
- 中断操作は Gate にも伝わります。中断時は `passthrough` 設定でも元の応答を出しません。
- OFF 時は Gate LLM を呼ばず、元のモデルのストリーミングを使います。

ON 時には本文のあるモデル応答ごとに Gate の待ち時間と API 利用料が加わります。ツール実行前の説明文も校正するため、その分の呼び出しが発生します。日本語以外の文章を意図的に出したい場合や機械処理用の JSON を本文として出したい場合は OFF にしてください。校正品質と Markdown の構造維持は指定した LLM の能力に依存します。

プロバイダー経由のテキスト応答を補正するため、同じランタイムの入れ子の LLM 呼び出しも対象になります。Gate 自身の呼び出しは再校正を避けます。生のプロバイダー通信を表示するデバッグ拡張は、通常出力とは別に元の通信を観測できます。

メインモデルのトークン数と使用量は元の値を保持します。Gate の使用量はセッションの `jp-gate-usage` カスタムエントリーに別途記録します。Pi の通常の使用量表示には Gate のトークン数・料金を合算しません。

## 開発・検証

```bash
npm ci
npm run check
npm pack --dry-run
```

`npm run check` は型チェック、ユニットテスト、実際の Pi CLI を使う結合テストを実行します。結合テストは模擬モデルを使い、外部 API 呼び出し・料金・実際の認証情報は不要です。ON/OFF、設定の優先順位、補正前の文章の非公開、Gate の失敗などを確認します。実際の LLM の日本語品質は利用するモデルで確認してください。

主な構成:

```text
extensions/jp-correct.ts    Pi の読み込み口
src/index.ts               CLI・対話コマンド・ライフサイクル
src/providers.ts           Pi プロバイダーのラップと復元
src/gate.ts                LLM による日本語校正
src/gate-prompt.ts         Gate LLM に渡すプロンプト
src/protected-text.ts      コード・URL のマスクと復元
src/stream.ts              校正前のストリーム保持と校正後の出力
src/config.ts              設定の読み込みと検証
test/                      ユニットテスト・CLI 結合テスト
```

プロンプトを変更する場合は `src/gate-prompt.ts` を編集してください。編集後は Pi を再起動して反映します。

## Git への push

ソース、設定例、ロックファイル、Apache 2.0 ライセンス、GitHub Actions の CI を含みます。個人設定・API キー・`node_modules` はコミット対象から除外しています。

リモートリポジトリーを作成後、URL を指定して push してください。

```bash
git remote add origin <repository-url>
git push -u origin main
```

すでに `origin` がある場合は `git remote set-url origin <repository-url>` で変更できます。
