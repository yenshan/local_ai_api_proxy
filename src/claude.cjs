const os = require('node:os');
const path = require('node:path');
const { CLIBackend, findExecutable } = require('./cli-backend.cjs');

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'].map(reasoningEffort => ({ reasoningEffort }));
// Claude Code has no model-listing command; its aliases always resolve to the latest model of each family.
const MODELS = [
  ['sonnet', 'Claude Sonnet (latest)'], ['opus', 'Claude Opus (latest)'], ['fable', 'Claude Fable (latest)'], ['haiku', 'Claude Haiku (latest)'],
].map(([model, displayName], i) => ({ id: model, model, displayName, supportedReasoningEfforts: EFFORTS, isDefault: i === 0 }));

function findClaude(configured) {
  const home = os.homedir();
  return findExecutable(configured, [path.join(home, '.local/bin/claude'), path.join(home, '.claude/local/claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude'], 'claude');
}
class ClaudeBackend extends CLIBackend {
  constructor({ binary, cwd } = {}) {
    // Unset the variables Claude Code sets for its own child processes so the
    // CLI also runs when this app was launched from a Claude Code session.
    super({ binary: findClaude(binary), cwd, label: 'Claude Code', hint: 'Run claude in a terminal to sign in, then try again.', env: { CLAUDECODE: undefined, CLAUDE_CODE_ENTRYPOINT: undefined } });
  }
  async start() {
    await super.start();
    const version = (await this.run(['--version'], { timeout: 15000 })).trim();
    this.version = version.split(/\s/)[0] || version;
  }
  async listModels() { return MODELS.map(m => ({ ...m })); }
  generate({ input, model, effort, signal, timeout, baseInstructions, onDelta, onEvent, onThread }) {
    return this.withDirectory('claude-', async directory => {
      // Text generation only: no built-in tools, MCP servers, slash commands,
      // settings files or saved sessions.
      const args = ['--print', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--model', model,
        '--tools', '', '--strict-mcp-config', '--disable-slash-commands', '--setting-sources', '', '--no-session-persistence',
        '--system-prompt', [baseInstructions, input.instructions].filter(Boolean).join('\n\n')];
      if (effort) args.push('--effort', effort);
      if (input.outputSchema) args.push('--json-schema', JSON.stringify(input.outputSchema));
      let text = ''; let result;
      const append = delta => { text += delta; onDelta(delta); };
      await this.run(args, { cwd: directory, signal, timeout, input: input.prompt, onEvent: event => {
        onEvent(event);
        if (event.type === 'system' && event.subtype === 'init') onThread(event.session_id);
        const e = event.type === 'stream_event' && !event.parent_tool_use_id ? event.event : null;
        if (e?.type === 'content_block_delta' && e.delta?.type === 'text_delta' && typeof e.delta.text === 'string' && !input.outputSchema) append(e.delta.text);
        if (event.type === 'result') result = event;
      } });
      if (signal.aborted) throw signal.reason;
      if (!result || result.is_error || result.subtype !== 'success') throw new Error((typeof result?.result === 'string' && result.result) || result?.errors?.join('; ') || `Claude Code ${result?.subtype || 'returned no result'}`);
      const finalText = input.outputSchema && result.structured_output !== undefined ? JSON.stringify(result.structured_output) : result.result;
      if (typeof finalText !== 'string') throw new Error('Claude Code returned no response text');
      if (input.outputSchema) append(finalText);
      else if (finalText.startsWith(text)) append(finalText.slice(text.length));
      else if (finalText !== text) throw new Error('Claude Code result differs from streamed text');
      const u = result.usage;
      const prompt = u ? (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0) : 0;
      const usage = u ? { inputTokens: prompt, outputTokens: u.output_tokens || 0, totalTokens: prompt + (u.output_tokens || 0), cachedInputTokens: u.cache_read_input_tokens || 0, reasoningOutputTokens: u.output_tokens_details?.thinking_tokens || 0 } : undefined;
      return { text, usage };
    });
  }
}
module.exports = { ClaudeBackend, findClaude, MODELS };
