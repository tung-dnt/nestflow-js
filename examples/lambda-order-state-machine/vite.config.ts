import { defineConfig } from 'vite-plus';

export default defineConfig({
  pack: {
    entry: ['src/lambda.ts'],
    sourcemap: true,
    shims: true,
    outputOptions: { codeSplitting: false },
    deps: {
      alwaysBundle: [/.*/],
      // The Lambda uses a Nest application context, not an HTTP, WebSocket, or microservice server.
      neverBundle: [/^@nestjs\/(microservices|platform-express|websockets)(\/|$)/],
      onlyBundle: false,
    },
  },
});
