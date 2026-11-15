# Codex Local API

Codex app-server または Antigravity CLI を使う、ローカルの OpenAI API 互換テストサーバーです。Mac アプリで起動・停止し、アプリから送信されたメッセージと AI の応答を確認できます。推論は Codex の接続先で実行されます。オフラインで動くモデルサーバーではありません。

## Mac アプリを使う

プロジェクト直下の `start.sh` でアプリを起動できます。初回のみ `npm ci` で依存パッケージを準備してください。

```sh
./start.sh
```

左サイドバーの右端をドラッグすると幅を調整できます。幅は次回起動時にも保持し、境界のダブルクリックで初期幅に戻せます。キーボードでは境界にフォーカスして左右キーで調整できます。

別のディレクトリから絶対パスで実行することもできます。`./start.sh --packaged` でビルド済みアプリを起動できます。

この環境用に作成したアプリ: `dist/mac-arm64/Codex Local API.app`（Apple Silicon）。Finder から開いて「サーバーを起動」を押してください。必要なら Applications フォルダにコピーできます。ローカル用の ad-hoc 署名済みです。Developer ID 署名・公証は行っていません。

前提として、Codex CLI がインストールされ、ログイン済みである必要があります。

```sh
codex login
```

Codex 実行ファイルは `/opt/homebrew/bin/codex`、`/usr/local/bin/codex`、`/Applications/Codex.app/Contents/Resources/codex`、PATH の順に探します。GUI の「サーバー設定」で絶対パスも指定できます。認証情報をこのアプリに入力する必要はありません。

既定の接続先は **`http://127.0.0.1:8787/v1`** です。テスト対象アプリの Base URL に設定してください。API キー入力が必須のクライアントでは `local` など任意の文字列を使えます。サーバーは API キーによる認証を行いません。

モデルは起動時と `/v1/models` アクセス時に、Codex app-server の `model/list` をページ送りして取得します。GUI の更新ボタンでも再取得できます。モデルカタログへの掲載と実際の利用権限は別で、利用可否はアカウントや接続先に依存します。モデル省略時はバックエンドが既定として返したモデル、一覧の先頭の順に選びます。

## Antigravity に切り替える

1. ターミナルで `agy` を起動し、Antigravity にログインしてください。`agy models` でモデル一覧を確認できます。IDE 用の `antigravity` コマンドではなく、非対話実行に対応した **Antigravity CLI (`agy`)** が必要です。
2. サーバーを停止してから、左サイドバーの「サーバー設定」の「AI バックエンド」で **Antigravity CLI** を選択します。変更は自動保存されます。稼働中・起動中・停止処理中は、すべての設定項目を編集できません。実行ファイルは `~/.local/bin/agy`、Homebrew、PATH から自動検出します。必要なら絶対パスを指定できます。
3. サーバーを起動すると、選択したバックエンドのモデル一覧が取得されます。Codex に戻すときも同じ手順です。

Base URL は共通の `http://127.0.0.1:8787/v1` です。`/v1/models`、Chat Completions、Responses、SSE、JSON Schema 出力、使用量、中断・タイムアウトに対応します。モデルは 接続テスト または API リクエストの `model` で選択してください。

Antigravity のモデルは `agy models` から取得したスラッグをそのまま使います。推論強度は `-low` / `-medium` / `-high` などを含むモデル名で選んでください。モデル別の対応強度を CLI が列挙しないため、Antigravity 選択時の `reasoning_effort` / `reasoning.effort` は明示的なエラーになります。

内部ではリクエストごとに専用の作業ディレクトリとテキスト生成用エージェントを作り、`agy` の NDJSON 入出力を OpenAI 形式へ変換します。システム指示は専用エージェントの指示に、会話は stdin に渡します。ツールは完了通知用の `finish` のみを許可し、スラッシュコマンド展開を無効にします。JSON Schema の場合は CLI の最終構造化出力を受け取ってから本文を送ります。中断時には当該 CLI プロセスを終了します。ユーザーの認証情報や CLI 設定は書き換えません。会話は CLI 側にも履歴が残る場合があり、ephemeral 保証は Codex のみです。

CLI のみで起動する場合:

```sh
AI_BACKEND=antigravity npm run server
# 自動検出できない場合
AI_BACKEND=antigravity ANTIGRAVITY_BINARY=/absolute/path/to/agy npm run server
```

接続方法の参照: [Antigravity headless mode](https://antigravity.google/docs/cli/headless)、[カスタムエージェント](https://antigravity.google/docs/subagents/)。

## Python OpenAI SDK で接続

```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:8787/v1", api_key="local")
models = client.models.list().data
model = models[0].id

reply = client.chat.completions.create(
    model=model,
    messages=[
        {"role": "system", "content": "簡潔な日本語で回答してください。"},
        {"role": "user", "content": "こんにちは！"},
    ],
)
print(reply.choices[0].message.content)

stream = client.responses.create(model=model, input="接続テストです。", stream=True)
for event in stream:
    if event.type == "response.output_text.delta":
        print(event.delta, end="", flush=True)
```

## JavaScript OpenAI SDK で接続

```js
import OpenAI from 'openai';

const client = new OpenAI({ baseURL: 'http://127.0.0.1:8787/v1', apiKey: 'local' });
const { data: models } = await client.models.list();
const stream = await client.chat.completions.create({
  model: models[0].id,
  messages: [{ role: 'user', content: 'ひとことで挨拶してください。' }],
  stream: true,
  stream_options: { include_usage: true },
});
for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta?.content ?? '');
}
```

ローカルで開発中の Web アプリからも使えます。CORS は `http(s)://localhost:<port>` と `http(s)://127.0.0.1:<port>` の Origin に対応しています。他の Origin は拒否します。ブラウザ用 OpenAI SDK では同 SDK の `dangerouslyAllowBrowser` 設定が必要です。

## API の対応範囲

| API / 機能 | 対応 |
| --- | --- |
| `GET /health` | サーバー状態 |
| `GET /v1/models` | 選択バックエンドに問い合わせたモデル一覧 |
| `POST /v1/chat/completions` | テキスト応答、SSE、`stream_options.include_usage` |
| `POST /v1/responses` | テキスト応答、Responses 形式の SSE イベント |
| system / developer / user / assistant | テキストとテキストパート配列 |
| `reasoning_effort` / `reasoning.effort` | 選択モデルの対応値を検証して転送 |
| `response_format.type=json_schema` | `json_schema.schema` → Codex `outputSchema` |
| `text.format.type=json_schema` | `schema` → Codex `outputSchema` |
| `user` / `metadata` / `store` | SDK 互換のため受理。外部のユーザー管理や Responses 保存機能は提供しない |
| 画像・音声・ファイル・Embeddings | 未対応 |
| `tools` / tool calls / tool messages | 未対応 |
| `temperature` / `top_p` / `max_tokens` / `max_output_tokens` / `stop` / `seed` / logprobs / `n>1` | 未対応 |
| `previous_response_id` / Responses 取得・削除 / background | 未対応 |
| JSON object モード | 未対応。JSON Schema を使用 |

未対応パラメーターは黙って無視せず、`400 unsupported_parameter` を返します。フレームワークが `temperature` や `max_tokens` を自動付与する場合は、その設定を外してください。OpenAI API 全体を完全再現するものではありません。

各 API リクエストは独立した ephemeral な Codex thread になります。会話履歴は毎回 `messages` または `input` に含めてください。Codex の安定版 `turn/start` はユーザー入力を受け取るため、過去の user/assistant メッセージはロール付き JSON の会話データとして渡し、system/developer は developer instructions に変換します。ネイティブ OpenAI API とプロンプト配置やトークン数が完全一致するわけではありません。使用量は Codex が通知した値を返します。

生成中は GUI の「生成を中断」、クライアント切断、タイムアウトで Codex の `turn/interrupt` を呼びます。同時生成は最大 16 件、リクエスト本文は最大 2 MiB。既定の生成タイムアウトは 180 秒です。SSE 開始後の失敗は Chat Completions では `error` データ、Responses では `response.failed` イベントに表示されます。

## ログと設定

GUI のログ欄には、送信メッセージと AI の応答だけを時系列で表示します。生成中の応答も随時更新されます。モデル一覧取得やヘルスチェックは表示しません。左の「接続テスト」でモデルと推論レベルを選択し、動作確認用のリクエストを送れます。Codex ではモデルが対応する推論レベルを表示し、Antigravity では利用可能な同系列のモデル名に含まれる推論レベルを選択できます。

- Mac アプリ: Electron の `userData`（通常 `~/Library/Application Support/Codex Local API/`。開発起動時はパッケージ名のフォルダになる場合があります）。保存先でログファイルを確認できます。
- CLI: プロジェクト内の `.local-data/`。
- `CODEX_LOCAL_DATA` 環境変数で保存先を変更可能。
- `settings.json`: バックエンド、ポート、各 CLI パス、タイムアウト。
- `logs/requests.jsonl`: 完了した通信を JSONL 保存。20 MiB を超えると `.1` にローテーション。GUI は直近 300 件を保持し、再起動時はファイル末尾の最大 8 MiB を読みます。
- 保存される内容は本文・応答・エラー・使用量・Codex イベントです。Authorization ヘッダーや Codex の認証情報は記録しません。本文中に含めた値はそのまま保存されます。

待ち受けは IPv4 の `127.0.0.1` 固定です。Codex はアプリ用の空ディレクトリで、read-only sandbox と approvalPolicy=never を指定して起動します。生成 thread のシェル・Web 検索・Apps と、ユーザー設定に含まれる MCP サーバーを無効化します。ユーザーの Codex 設定ファイルを書き換えることはありません。

## 開発・ビルド

macOS で Node.js と npm をインストール済みなら、次の一回で依存パッケージのインストール、Electron バイナリの準備、`.app` のビルド、ローカル署名の検証まで実行できます。初回はダウンロードのためネット接続が必要です。

```sh
./build-mac.sh
```

出力先は Apple Silicon では `dist/mac-arm64/Codex Local API.app`、Intel では `dist/mac/Codex Local API.app` です。使用中の Node.js のアーキテクチャに合わせてビルドします。別のディレクトリからスクリプトのパスを指定しても実行できます。

個別に実行する場合:

```sh
npm ci
npm start                 # Mac GUI
npm run server            # GUI なしでサーバー起動
npm test                  # モックと実際の HTTP/JSONL 通信による自動テスト
npm run build             # dist/mac-arm64/Codex Local API.app
npm run dist              # DMG 作成（配布用署名・公証は別途必要）
```

CLI の環境変数: `PORT`、`AI_BACKEND`（`codex` / `antigravity`）、`CODEX_BINARY`、`ANTIGRAVITY_BINARY`、`CODEX_LOCAL_DATA`。Electron の初回起動時にバイナリをダウンロードするバージョンでは、`npm start` を一度実行してからビルドしてください。

実 Codex と GUI のスモークテスト:

```sh
npm start -- --smoke                      # 起動、モデル取得、GUI 状態を確認
npm start -- --smoke --smoke-inference    # 実生成を3回実行してストリーム・構造化出力を確認
npm start -- --smoke --smoke-antigravity --smoke-inference # Antigravity の実生成確認
npm start -- --packaged --smoke          # ビルドした .app の起動を確認
```

実生成テストは Codex の利用枠を使います。開発起動のスモークテストは `.local-data/gui-smoke/` を使用し、スクリーンショットを `.local-data/gui-smoke.png` に出力します。

実装で参照した公式仕様: [Codex App Server](https://learn.chatgpt.com/docs/app-server)、[Responses streaming events](https://developers.openai.com/api/reference/resources/responses/streaming-events)。ローカルの Codex CLI 0.167.0 が生成した TypeScript スキーマでもパラメーターを確認しています。
