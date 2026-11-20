# Local AI API Proxy

![Local AI API Proxy: server settings, connection test, and traffic log](docs/images/app-screenshot.png)

Run an OpenAI-compatible REST API server on macOS or Linux at `http://127.0.0.1:8787/v1`. Supports Codex app-server, Antigravity CLI, and Claude Code as AI backends.

## Getting started

For backend installation and sign-in instructions, see the official guides for [Codex CLI](https://learn.chatgpt.com/docs/codex/cli) and [Antigravity CLI](https://antigravity.google/docs/getting-started?tab=cli), and [Claude Code](https://code.claude.com/docs/en/quickstart).

```sh
./start.sh
```

## Building the Mac app

```sh
./build-mac.sh
```

Output path (based on your Node.js architecture):

- Apple Silicon (arm64): `dist/mac-arm64/Local AI API Proxy.app`
- Intel (x64): `dist/mac/Local AI API Proxy.app`

## Building the Linux app

Run on Linux with Node.js and npm installed:

```sh
./build-linux.sh
```

This installs dependencies, prepares Electron, builds the app, and checks the output. The initial download requires a network connection.

- x64: `dist/linux-unpacked/local-ai-api-proxy`
- arm64: `dist/linux-arm64-unpacked/local-ai-api-proxy`

Run the executable from the generated folder. Keep the entire folder together when copying the app to another machine. Backend CLI installation and sign-in are still required.

## Technical documentation

See [TECHNINCAL-NOTE.md](TECHNINCAL-NOTE.md) for API integration examples, API compatibility and execution behavior, settings and log storage, headless operation, and Mac app build and test instructions.
