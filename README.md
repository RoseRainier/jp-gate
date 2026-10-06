# jp-gate

Pi のモデル応答を、表示・保存する前に別の **Gate LLM** で日本語補正する拡張です。メインモデルは Pi で選んだまま、補正用のモデルを別に指定できます。

既定のプロンプトでは、文章に混ざった英語・中国語・韓国語を日本語にし、問題のない文章や製品名・API 名・文体・Markdown の構造を維持するよう指示します。翻訳は LLM が行い、プログラム側ではコード・URL の保護と補正結果の検証を行います。

```text
メインモデル → 応答を保持 → Gate LLM で補正 → 検証・コード復元 → Pi が表示・保存
```

## インストールと起動

必要な環境は Node.js 22.19 以降、Pi 1.x、Pi に登録・認証済みの Gate 用モデルです。`@earendil-works/pi-coding-agent` / `@earendil-works/pi-ai` 1.0.2 で検証しています。

```bash
pi install git:github.com/RoseRainier/jp-gate
pi --jp-gate on \
  --jp-gate-model openai/gpt-4.1-mini \
  --jp-gate-validation json
```

この起動例は、補正結果の形式変更を許容する `json` モードを指定しています。形式変更も検証したい場合は `--jp-gate-validation strict` を使います。指定を省略した場合は設定ファイルの値、設定もなければ `strict` が使われます。

`openai/gpt-4.1-mini` は指定方法の例です。`pi --list-models` で利用できるモデルを確認し、Gate 用の `provider/model-id` に置き換えてください。認証には Pi のプロバイダー設定・API キー・OAuth を利用します。

更新する場合は次を実行し、Pi を再起動します。

```bash
pi update git:github.com/RoseRainier/jp-gate
```

ローカルのソースを使う場合は `pi install /absolute/path/to/jp_correct` で登録できます。開発時の直接読み込みは後述の「開発・検証」を参照してください。TypeScript を直接読み込むため、ビルドは不要です。

## 設定ファイル

毎回 CLI で指定する代わりに、次の場所へ `jp-gate.json` を作成できます。

| 適用範囲 | 場所 |
| --- | --- |
| 全体設定 | `~/.pi/agent/jp-gate.json` |
| 作業ディレクトリーの設定 | `<cwd>/.pi/jp-gate.json` |
| 明示した追加設定 | `--jp-gate-config <path>` で指定したファイル |

`PI_CODING_AGENT_DIR` を指定している場合、全体設定はそのディレクトリー内の `jp-gate.json` を使います。作業ディレクトリーの設定は起動時の `<cwd>` が対象で、親ディレクトリーの `.pi/jp-gate.json` は探索しません。追加設定の相対パスも `<cwd>` を基準に解決します。

以下は、補正結果の形式変更を許容し、補正失敗時には応答を止める設定例です。

```json
{
  "enabled": true,
  "gate": {
    "model": "openai/gpt-4.1-mini",
    "timeoutMs": 60000,
    "maxTokens": 8192,
    "temperature": 0
  },
  "failureMode": "block",
  "validationMode": "json"
}
```

各ファイルには変更したい項目だけを書けます。API キーは Pi 側に設定し、このファイルには書きません。既定の `strict` モードを使う設定例は [examples/jp-gate.json](examples/jp-gate.json) にあります。

| 項目 | 拡張の既定値 | 意味 |
| --- | --- | --- |
| `enabled` | `true` | 補正の ON/OFF |
| `gate.model` | 未指定 | Gate 用の `provider/model-id`。補正対象の本文がある場合に必須 |
| `gate.promptFile` | 自動選択 | カスタム Markdown プロンプトのパス。指定時はこのファイルを優先 |
| `gate.timeoutMs` | `60000` | Gate の待機上限。ミリ秒の正整数 |
| `gate.maxTokens` | `8192` | Gate の出力トークン上限。正整数 |
| `gate.temperature` | `0` | Gate の temperature。`0`〜`2` |
| `failureMode` | `block` | 補正失敗時の動作。`block` / `passthrough` |
| `validationMode` | `strict` | 補正結果の検証。`strict` / `json` |

設定の優先順位は、低い順に **既定値 → 全体設定 → 作業ディレクトリーの設定 → 明示した追加設定 → CLI** です。`gate` 内の項目も個別に上書きします。未対応の項目や不正な値は設定エラーになります。

設定ファイルやプロンプトの Markdown を編集した後は `/jp-gate reload` または Pi の再起動で反映します。`/jp-gate reload` は起動時の CLI 指定も再適用するため、CLI で指定した値は設定ファイルの編集だけでは変わりません。

モデル指定は最初の `/` で区切ります。`openrouter/vendor/model-id` のようにモデル ID 自体に `/` があっても指定できます。`gate.maxTokens` がモデルの出力上限を超える場合は、モデルの上限に合わせて呼び出します。

## CLI と対話コマンド

インストール済みなら、通常の `pi` 起動に次のフラグを追加できます。

| CLI フラグ | 指定する値 | 動作 |
| --- | --- | --- |
| `--jp-gate` | `on` / `off` | 補正を有効化／無効化 |
| `--jp-gate-model` | `provider/model-id` | Gate モデルを指定 |
| `--jp-gate-validation` | `strict` / `json` | 検証モードを指定 |
| `--jp-gate-config` | ファイルパス | 全体・作業ディレクトリーの設定に追加して読み込み |
| `--jp-gate-prompt` | Markdown ファイルのパス | Gate のプロンプトを明示指定 |

例えば、補正を無効にして起動する場合は `pi --jp-gate off`、追加設定を使う場合は `pi --jp-gate-config ./my-settings.json` と指定します。

対話中は次のコマンドを使います。

| コマンド | 動作 |
| --- | --- |
| `/jp-gate` または `/jp-gate status` | ON/OFF・モデル・プロンプトのパス・検証モード・設定ファイルなどを表示 |
| `/jp-gate on` | 補正を有効化 |
| `/jp-gate off` | 補正を無効化 |
| `/jp-gate model provider/model-id` | Gate モデルを変更 |
| `/jp-gate validation json` | 補正結果の形式変更を許容 |
| `/jp-gate validation strict` | 本文の個数・形式も検証 |
| `/jp-gate reload` | 設定ファイル・プロンプトと起動時の CLI 指定を再読み込み |

対話コマンドによる設定変更は現在のセッション内で有効です。永続化する場合は設定ファイルを編集してください。再読み込みすると、対話中に変更した値も設定ファイルと CLI の値に戻ります。

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

プロンプトを変更する際も、入力が `texts` 配列であること、出力を JSON にすること、`⟦JP_GATE_...⟧` の保護マーカーを保持することを指示してください。JSON 構文・保護マーカーなどの検証はプログラム側で引き続き行います。

存在しない明示指定ファイル、読めないファイル、空のプロンプトはエラーにします。別のプロンプトへの切り替えや上書きは行いません。OFF 時にはプロンプトを読み込まず、`/jp-gate on` で有効化するときに読み込みます。

## 補正結果の検証

検証する JSON は **Gate LLM が返す補正結果** です。メインモデルの本文は通常の文章や Markdown のままで使えます。Pi の `--mode json` はイベントの出力形式を選ぶ別の設定です。

Gate へは、保護対象をマスクした本文を `{"texts":["本文"]}` で送ります。この配列の要素はメインモデルの本文ブロック（`text` 要素）に対応し、一つの要素に複数の文・段落・改行が含まれることがあります。

### `strict`：個数・形式も検証（既定）

Gate の返答は `{"texts":["補正後の本文"]}` 形式で、`texts` は文字列の配列、要素数は入力と同じである必要があります。補正後の各要素を元の本文位置に戻します。

例外として、本文を改行位置で分割しただけで、全要素の内容・順序が原文と一致する場合は、元の改行と本文ブロックを復元します。要素数が変わり、分割された本文に翻訳・変更・欠落がある場合はエラーになります。

### `json`：形式変更を許容

有効な JSON であれば、本文ブロック数や JSON の構造が入力と異なっていても受け付けます。次の形式から本文を取り出します。

| Gate の返答例 | 取り出す本文 |
| --- | --- |
| `{"texts":["こんにちは。"]}` | `こんにちは。` |
| `{"texts":"こんにちは。"}` | `こんにちは。` |
| `["こんにちは。"]` | `こんにちは。` |
| `"こんにちは。"` | `こんにちは。` |

それ以外の有効な JSON は JSON として再出力します。例えば `{"result":"こんにちは。"}` はそのオブジェクトを本文として出力します。数値・真偽値・`null` もこの扱いです。

取り出した本文の個数が入力と同じなら元の本文位置に戻し、異なる場合は空行（`\n\n`）で結合して最初の本文位置に出力します。thinking とツール呼び出しは保持します。内容が変わっていない改行位置での分割は、`strict` と同様に元の本文を復元します。

### 両モード共通の確認

- JSON 構文が不正な返答は失敗として扱います。`json` モードでも、JSON の前後に説明文が付いた返答は通りません。JSON 全体が `json` または言語指定のない単一のコードフェンスで囲まれている場合は受け付けます。
- Gate の正常終了を確認します。出力上限による途中終了、エラー、Gate からのツール呼び出しは失敗として扱います。
- コード・URL の保護マーカーの欠落・重複・順序変更・未知のマーカーを検証します。`json` モードでもこの保護は有効です。
- 空の本文を拒否します。`strict` は元の空でない本文が空になった場合、`json` は取り出した本文全体が空の場合に失敗します。`[]` や `{"texts":[]}` も `json` モードでは失敗します。

検証モードを変えても Gate に渡すプロンプトは同じです。既定のプロンプトは、どちらのモードでも `texts` 配列の個数・順序を維持するよう指示します。

## 補正対象と失敗時の動作

ON 時は、日本語だけの文章も含め、補正対象の本文を Gate LLM へ渡します。本文のない応答やコード・URL などの保護対象だけの本文は、そのまま通します。OFF 時は Gate を呼ばず、メインモデルの通常のストリーミングを使います。

コードフェンス・インラインコード・インデントされたコード・URL・リンク先・HTML タグはマスクし、補正後に原文を戻します。thinking とツール呼び出しの引数は補正しません。見出し・リストなどの Markdown 構造と日本語補正の品質は Gate モデルに依存します。

Gate に渡すのはマスク済みの本文です。会話履歴、メインモデルの system prompt、thinking、ツールの定義・引数は渡しません。プロバイダーを経由する同じランタイム内の入れ子の LLM 呼び出しも対象になりますが、Gate 自身の呼び出しは再校正しません。

| `failureMode` | Gate が失敗した場合 |
| --- | --- |
| `block`（既定） | 応答をエラーにし、本文とその応答に含まれるツール呼び出しを出力しない |
| `passthrough` | 警告を出し、メインモデルの元の応答を出力する |

中断操作は Gate にも伝わります。中断時は `passthrough` でも元の応答を出力しません。

補正中はメインモデルのストリームを保持するため、本文の表示は Gate の処理後になります。通常出力（TUI・print・JSON・RPC）とセッション履歴には、補正を通った本文を渡します。`passthrough` で補正に失敗した場合は元の本文が出力・保存されます。

ON 時は補正対象の応答ごとに Gate の待ち時間とモデル利用量が加わります。ツール実行前の説明文も補正対象です。Gate が従量課金モデルなら利用料が発生します。メインモデルの使用量は保持し、Gate の使用量はセッションの `jp-gate-usage` に別途記録します。Pi の通常の使用量表示には合算しません。

意図的に外国語を出したい場合や、メインモデルが返す機械処理用 JSON をそのまま使いたい場合は `/jp-gate off` で無効にしてください。

## よくあるエラー

| 症状 | 対処 |
| --- | --- |
| Gate モデルが未設定／未登録 | `pi --list-models` で確認し、`gate.model` または `--jp-gate-model` に登録済みのモデルを指定する |
| 「文章の数を変更しました」 | 形式差を許容するなら `validationMode: "json"` または `/jp-gate validation json` を使う |
| 「有効な JSON ではありません」 | Gate のプロンプトやモデルを見直す。JSON 構文の確認は両モードで有効 |
| 保護用マーカーのエラー | コード・URL のマーカーを保持できるよう Gate のプロンプトやモデルを見直す |
| プロンプトが読めない／空 | `/jp-gate status` やエラーに表示されたパスを確認し、内容のある Markdown を保存して `/jp-gate reload` を実行する |
| タイムアウト／出力上限による途中終了 | `gate.timeoutMs` / `gate.maxTokens` を調整する。出力上限はモデル側の制限も確認する |
| 設定の変更が反映されない | `/jp-gate status` で設定ファイルを確認し、`/jp-gate reload` を実行する。CLI 指定はファイル設定より優先 |

## 開発・検証

プロンプトの Markdown は `/jp-gate reload` で読み直せます。拡張の TypeScript ソースを変更した場合は Pi を再起動してください。

このリポジトリーのソースを直接読み込んで確認する場合は、`--no-extensions` で自動検出を停止し、`-e` でこの拡張を読み込みます。

```bash
npm ci
pi --no-extensions -e ./extensions/jp-correct.ts \
  --jp-gate on \
  --jp-gate-model openai/gpt-4.1-mini \
  --jp-gate-validation json
```

開発時の検証:

```bash
npm run check
npm pack --dry-run
```

`npm run check` は型チェック、ユニットテスト、実際の Pi セッション・CLI を使う結合テストを実行します。テストは模擬モデルを使い、外部 API 呼び出しや実際の認証情報は不要です。ON/OFF、設定とプロンプトの優先順位、更新後のプロンプト保持・再読み込み、検証モード、補正前の本文が漏れないこと、失敗・中断時の動作などを確認します。実際の補正品質は使用する Gate モデルで確認してください。

| ファイル | 役割 |
| --- | --- |
| [extensions/jp-correct.ts](extensions/jp-correct.ts) | Pi の読み込み口 |
| [src/index.ts](src/index.ts) | CLI・対話コマンド・ライフサイクル |
| [src/config.ts](src/config.ts) | 設定の読み込みと検証 |
| [src/gate.ts](src/gate.ts) | Gate 呼び出し・補正結果の検証 |
| [prompts/jp-gate.md](prompts/jp-gate.md) | 編集用ファイルの初期テンプレート |
| [src/prompt.ts](src/prompt.ts) | 外部 Markdown の選択・初回作成・読み込み |
| [src/protected-text.ts](src/protected-text.ts) | コード・URL のマスクと復元 |
| [src/providers.ts](src/providers.ts) | Pi プロバイダーのラップと復元 |
| [src/stream.ts](src/stream.ts) | ストリームの保持と補正後の出力 |
| [test/](test/) | ユニットテスト・結合テスト |

ライセンスは [Apache-2.0](LICENSE) です。
