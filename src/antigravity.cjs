const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CLIBackend, findExecutable } = require('./cli-backend.cjs');

const AGENT = 'local-api-text';
function findAntigravity(configured) {
  return findExecutable(configured, [path.join(os.homedir(), '.local/bin/agy'), '/opt/homebrew/bin/agy', '/usr/local/bin/agy'], 'agy');
}
function parseModels(output) {
  const models = [];
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^([a-z0-9][a-z0-9._-]*)[\t ]+(.+)$/);
    if (match && !models.some(m => m.model === match[1])) models.push({ id: match[1], model: match[1], displayName: match[2].trim(), supportedReasoningEfforts: [], isDefault: false });
  }
  if (!models.length) throw new Error('Could not load Antigravity models. Sign in with agy and try again.');
  models[0].isDefault = true;
  return models;
}
class AntigravityBackend extends CLIBackend {
  constructor({ binary, cwd } = {}) {
    super({ binary: findAntigravity(binary), cwd, label: 'Antigravity', hint: 'Sign in with agy and try again.' });
  }
  async listModels() { return parseModels(await this.run(['models'])); }
  generate({ input, model, signal, timeout, baseInstructions, onDelta, onEvent, onThread }) {
    return this.withDirectory('antigravity-', async directory => {
      fs.mkdirSync(path.join(directory, '.git'));
      const agents = path.join(directory, '.agents', 'agents'); fs.mkdirSync(agents, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(agents, `${AGENT}.md`), `---\nname: ${AGENT}\ndescription: Text generation for the local API\nmainAgent: true\nsubagent: false\ntools: [finish]\nenabledTools: [finish]\nmcpServers: []\nskills: []\nplugins: []\ncommandExecutionPolicy: off\n---\n${baseInstructions}\n\n${input.instructions || ''}\n`, { mode: 0o600 });
      const args = ['--input-format', 'stream-json', '--output-format', 'stream-json', '--disable-slash-commands', '--agent', AGENT, '--model', model];
      if (input.outputSchema) args.push('--json-schema', JSON.stringify(input.outputSchema));
      let text = ''; let result;
      const append = delta => { text += delta; onDelta(delta); };
      await this.run(args, { cwd: directory, signal, timeout, input: JSON.stringify({ event: 'user', message: { content: input.prompt } }) + '\n', onEvent: event => {
        onEvent(event);
        if (event.event === 'init') {
          onThread(event.conversation_id);
          if (event.init?.agent !== AGENT) throw new Error('Antigravity did not select the local API agent');
        }
        if (event.event === 'step_update' && event.step_update?.step_type === 'agent_response' && typeof event.step_update.text_delta === 'string' && !input.outputSchema) append(event.step_update.text_delta);
        if (event.event === 'result') result = event.result;
      } });
      if (signal.aborted) throw signal.reason;
      if (!result || result.status !== 'SUCCESS') throw new Error(result?.error || `Antigravity ${result?.status || 'returned no result'}`);
      const finalText = input.outputSchema && result.structured_output !== undefined ? JSON.stringify(result.structured_output) : result.response;
      if (typeof finalText !== 'string') throw new Error('Antigravity returned no response text');
      if (input.outputSchema) append(finalText);
      else if (finalText.startsWith(text)) append(finalText.slice(text.length));
      else if (finalText !== text) throw new Error('Antigravity result differs from streamed text');
      const u = result.usage;
      const usage = u ? { inputTokens: u.input_tokens || 0, outputTokens: u.output_tokens || 0, totalTokens: u.total_tokens ?? ((u.input_tokens || 0) + (u.output_tokens || 0)), cachedInputTokens: u.cache_read_tokens || 0, reasoningOutputTokens: u.thinking_tokens || 0 } : undefined;
      return { text, usage };
    });
  }
}
module.exports = { AntigravityBackend, findAntigravity, parseModels };
