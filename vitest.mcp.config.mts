import { defineConfig } from 'vitest/config';

// Tests that drive the real `oprojects-mcp` binary as a process (see scripts/mcp-tests). They need `npm run build -w
// packages/mcp` first, or OPROJECTS_MCP_BIN pointing at a built binary, so they are kept out of the default `npm test`.
export default defineConfig({
  test: {
    include: ['scripts/mcp-tests/**/*.test.ts'],
    environment: 'node',
    globalSetup: ['scripts/mcp-tests/global-setup.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
