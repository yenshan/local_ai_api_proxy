# Local AI API Proxy

![Local AI API Proxy: server settings, connection test, and traffic log](docs/images/app-screenshot.png)

Run an OpenAI-compatible REST API server on your Mac at `http://127.0.0.1:8787/v1`. Supports Codex app-server and Antigravity CLI as AI backends.

## Getting started

For backend installation and sign-in instructions, see the official guides for [Codex CLI](https://learn.chatgpt.com/docs/codex/cli) and [Antigravity CLI](https://antigravity.google/docs/getting-started?tab=cli).

```sh
./start.sh
```

Requires Node.js and npm. On startup, `start.sh` automatically installs missing or incompatible application dependencies using `npm ci --include=dev` before launching the app.

On Linux, the app uses software rendering to avoid GPU/VA-API driver initialization errors.

## Building the Mac app

```sh
./build-mac.sh
```

Output path (based on your Node.js architecture):

- Apple Silicon (arm64): `dist/mac-arm64/Local AI API Proxy.app`
- Intel (x64): `dist/mac/Local AI API Proxy.app`

## Technical documentation

See [TECHNINCAL-NOTE.md](TECHNINCAL-NOTE.md) for API integration examples, API compatibility and execution behavior, settings and log storage, headless operation, and Mac app build and test instructions.
