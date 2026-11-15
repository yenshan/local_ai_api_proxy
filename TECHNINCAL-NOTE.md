# Technical notes

Technical documentation for Local AI API Proxy. See the [README](README.md) for an overview, setup, and GUI usage.

## Development prerequisites

Install Node.js and npm on macOS, and install and sign in to the backend you want to use.

| Backend | Authentication and verification | Executable discovery order |
| --- | --- | --- |
| Codex app-server | Run `codex login` | `/opt/homebrew/bin/codex`, `/usr/local/bin/codex`, `/Applications/Codex.app/Contents/Resources/codex`, then PATH |
| Antigravity CLI | Launch `agy` to sign in; check models with `agy models` | `~/.local/bin/agy`, `/opt/homebrew/bin/agy`, `/usr/local/bin/agy`, then PATH |

Antigravity requires the **`agy` CLI** with non-interactive execution support, rather than the IDE's `antigravity` command. The app uses the CLI's existing credentials.

Install dependencies before the first launch:

```sh
npm ci
```

## Connecting other applications

The default base URL is **`http://127.0.0.1:8787/v1`**. If you change the port, use the URL shown in the app. The copy button copies that URL.

If your client requires an API key, use any string, such as `local`. This server does not enforce API-key authentication. It listens only on IPv4 `127.0.0.1`.

### Python OpenAI SDK

```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:8787/v1", api_key="local")
model = client.models.list().data[0].id

reply = client.chat.completions.create(
    model=model,
    messages=[
        {"role": "system", "content": "Keep your answers brief."},
        {"role": "user", "content": "Hello!"},
    ],
)
print(reply.choices[0].message.content)

stream = client.responses.create(model=model, input="Test the connection.", stream=True)
for event in stream:
    if event.type == "response.output_text.delta":
        print(event.delta, end="", flush=True)
```

### JavaScript OpenAI SDK

```js
import OpenAI from 'openai';

const client = new OpenAI({ baseURL: 'http://127.0.0.1:8787/v1', apiKey: 'local' });
const { data: models } = await client.models.list();
const stream = await client.chat.completions.create({
  model: models[0].id,
  messages: [{ role: 'user', content: 'Say hello briefly.' }],
  stream: true,
  stream_options: { include_usage: true },
});
for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta?.content ?? '');
}
```

Local web applications can connect too. CORS allows `http(s)://localhost:<port>` and `http(s)://127.0.0.1:<port>` origins and rejects other origins. The OpenAI browser SDK also requires its `dangerouslyAllowBrowser` option.

## API compatibility

| API or feature | Codex app-server | Antigravity CLI |
| --- | --- | --- |
| `GET /health` | Server status and backend name | Same |
| `GET /v1/models` | Paginated `model/list` results | Results from `agy models` |
| `POST /v1/chat/completions` | Text, SSE, and `stream_options.include_usage` | Same |
| `POST /v1/responses` | Text and Responses-style SSE | Same |
| system / developer / user / assistant | Text and arrays of text parts | Same |
| `reasoning_effort` / `reasoning.effort` | Validated against the model's supported values and forwarded | Unsupported; select a model variant instead |
| `response_format.type=json_schema` | Schema forwarded as `outputSchema` | Schema forwarded with `--json-schema` |
| `text.format.type=json_schema` | Same mapping | Same mapping |
| `user` (Chat Completions) / `metadata` / `store` | Accepted for compatibility; no user-management or Responses storage/retrieval service | Same |
| Images / audio / files / embeddings | Unsupported | Unsupported |
| `tools` / tool calls / tool messages | Unsupported | Unsupported |
| `temperature` / `top_p` / `max_tokens` / `max_output_tokens` / `stop` / `seed` / logprobs / `n>1` | Unsupported | Unsupported |
| `previous_response_id` / Responses retrieval or deletion / background | Unsupported | Unsupported |
| JSON object mode | Unsupported; use JSON Schema | Same |

This app implements a subset of the OpenAI API. Unsupported parameters return errors such as `400 unsupported_parameter`. Disable automatic `temperature` or `max_tokens` parameters in clients that add them.

If `model` is omitted, the server selects the catalog's default model, falling back to the first model. For Antigravity, the first model returned by `agy models` is treated as the default.

### Conversation and execution behavior

Each API request is independent. Include conversation history in every `messages` or `input` payload. The connection-test form sends a user message; API clients can also send system/developer messages or Responses `instructions`.

- **Codex:** Each request creates an ephemeral thread. System/developer messages become developer instructions, and multi-message user/assistant history is passed as role-labeled JSON conversation data. The app uses its own working directory, a read-only sandbox, and approval policy `never`. Shell tools, web search, Apps, and inherited MCP servers are disabled for generation threads.
- **Antigravity:** Each request uses a dedicated working directory and text-generation agent, with CLI NDJSON converted into OpenAI-compatible output. Only the `finish` completion tool is enabled, and slash-command expansion is disabled. JSON Schema output is sent after the final structured result arrives. The CLI may retain conversation history; ephemeral storage is not guaranteed.

Prompt placement and token counts can differ from the native OpenAI API. Usage values come from the backend. The app does not rewrite your CLI configuration or credentials.

The server allows up to 16 concurrent generations and request bodies up to 2 MiB. Client disconnection, timeout, or server shutdown interrupts generation: Codex uses `turn/interrupt`, while Antigravity terminates the corresponding CLI process. Failures after SSE starts appear as `error` data for Chat Completions or `response.failed` events for Responses.

## Settings and log storage

| Launch method | Storage directory |
| --- | --- |
| Packaged Mac app | `~/Library/Application Support/Codex Local API/` |
| Development GUI (`./start.sh` / `npm start`) | `~/Library/Application Support/codex-local-api/` |
| CLI (`npm run server`) | `.local-data/` inside the current working directory |

The GUI retains the old directory names to preserve existing data after the app rename. Set `CODEX_LOCAL_DATA` to override the settings and traffic-log directory. UI preferences, including sidebar state, are stored in the GUI profile.

- `settings.json`: Backend, port, CLI executable paths, and generation timeout.
- `logs/requests.jsonl`: Completed requests in JSONL format; rotated to `.1` after the file exceeds 20 MiB.
- The app keeps up to 300 recent entries and reads at most the last 8 MiB on launch. JSON export includes the Chat Completions and Responses entries shown in the traffic panel.
- Stored data includes messages, responses, errors, usage, and backend events. Authorization headers and CLI credentials are not recorded. Values included in message bodies are stored as supplied.

## Running without the GUI

```sh
npm run server
```

To use Antigravity:

```sh
AI_BACKEND=antigravity npm run server
```

| Environment variable | Purpose |
| --- | --- |
| `AI_BACKEND` | `codex` or `antigravity` |
| `PORT` | Listening port |
| `CODEX_BINARY` | Path to the Codex executable |
| `ANTIGRAVITY_BINARY` | Path to the `agy` executable |
| `CODEX_LOCAL_DATA` | Settings and traffic-log directory; also supported by the GUI |

The CLI loads saved settings, overrides them with supplied environment variables, and saves the result. Press `Ctrl+C` to stop.

## Building the Mac app

```sh
./build-mac.sh
```

This installs dependencies, prepares Electron, builds the `.app`, and verifies its local signature. The initial download requires a network connection.

| Node.js architecture | Output |
| --- | --- |
| Apple Silicon (arm64) | `dist/mac-arm64/Local AI API Proxy.app` |
| Intel (x64) | `dist/mac/Local AI API Proxy.app` |

Open the built app in Finder or run `./start.sh --packaged`. You can also copy it into Applications. Builds use a local ad-hoc signature, without Developer ID signing or notarization.

Individual commands:

```sh
npm start       # Development GUI
npm run server  # Headless API server
npm test        # HTTP, JSONL, SDK, and export tests
npm run build   # Build the .app
npm run dist    # Build a DMG; distribution signing/notarization is separate
```

### Real-backend and GUI smoke tests

Close the normally running app before starting a smoke test.

```sh
npm start -- --smoke                       # Startup, model catalog, and GUI checks
npm start -- --smoke --smoke-inference     # Three real generations
npm start -- --smoke --smoke-antigravity   # Antigravity startup check
npm start -- --smoke --smoke-antigravity --smoke-inference
npm start -- --packaged --smoke            # Check the built app
```

Without `--smoke-antigravity`, the test uses the backend saved in its smoke-test settings. Real generations consume the selected provider's quota. Development tests store data in `.local-data/gui-smoke/` and save a screenshot to `.local-data/gui-smoke.png`. Packaged tests use `local-ai-api-proxy-smoke/` inside the system temporary directory.

Reference specifications: [Codex App Server](https://learn.chatgpt.com/docs/app-server), [Antigravity headless mode](https://antigravity.google/docs/cli/headless).
