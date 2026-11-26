FROM postgres:17-alpine AS database
COPY examples/broker-workflow/schema.sql /docker-entrypoint-initdb.d/01-nestflow.sql

FROM node:26.13.1-bookworm-slim AS worker
WORKDIR /workspace
RUN npm install --global pnpm@12.23.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY docs/package.json docs/package.json
COPY examples/lambda-order-state-machine/package.json examples/lambda-order-state-machine/package.json
COPY packages/ packages/
COPY examples/broker-workflow/package.json examples/broker-workflow/package.json
RUN pnpm --filter broker-workflow... --filter '@nestflow-js/validator-*...' install --frozen-lockfile
COPY tsconfig.json vite.config.ts ./
COPY examples/broker-workflow/tsconfig.json examples/broker-workflow/vite.config.ts examples/broker-workflow/
COPY examples/broker-workflow/src/ examples/broker-workflow/src/
RUN pnpm build && pnpm --filter broker-workflow build
ENV NODE_ENV=production
WORKDIR /workspace/examples/broker-workflow
USER node
CMD ["node", "dist/container.js"]
