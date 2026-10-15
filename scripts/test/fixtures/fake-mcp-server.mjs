// A tiny MCP server over stdio, used to test the test client. Behavior is steered by environment variables:
//   FAKE_EXIT_AFTER_INIT=1  exits right after answering `initialize`
//   FAKE_SILENT=1           never answers `tools/call`
//   FAKE_GARBAGE=1          writes a non-JSON line before answering
import * as readline from 'node:readline';

const send = (m) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`);
const tools = [1, 2, 3].map((n) => ({
  name: `tool_${n}`,
  description: `Tool ${n}`,
  inputSchema: { type: 'object', properties: {} },
}));

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.id === undefined) return;
  if (process.env.FAKE_GARBAGE) process.stdout.write('this is not json\n');
  switch (msg.method) {
    case 'initialize':
      send({
        id: msg.id,
        result: {
          protocolVersion: msg.params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: 'fake', version: '1.2.3' },
        },
      });
      if (process.env.FAKE_EXIT_AFTER_INIT) process.exit(3);
      return;
    case 'tools/list':
      if (msg.params?.cursor === 'page2') return send({ id: msg.id, result: { tools: [tools[2]] } });
      return send({ id: msg.id, result: { tools: tools.slice(0, 2), nextCursor: 'page2' } });
    case 'tools/call':
      if (process.env.FAKE_SILENT) return;
      if (msg.params.name === 'boom')
        return send({ id: msg.id, error: { code: -32602, message: 'Invalid params', data: { field: 'x' } } });
      send({ method: 'notifications/message', params: { level: 'info', data: 'called' } });
      return send({
        id: msg.id,
        result: {
          content: [
            { type: 'text', text: `called ${msg.params.name}` },
            { type: 'text', text: JSON.stringify(msg.params.arguments) },
          ],
        },
      });
    default:
      return send({ id: msg.id, error: { code: -32601, message: 'Method not found' } });
  }
});
