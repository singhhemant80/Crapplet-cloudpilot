FROM node:22-bookworm-slim AS build
WORKDIR /src
COPY package.json package-lock.json ./
COPY packages/hypervisor-sdk/package.json packages/hypervisor-sdk/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --workspace @cloudpilot/web --include-workspace-root
COPY apps/web apps/web
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build -w @cloudpilot/web

FROM node:22-bookworm-slim
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
WORKDIR /app
RUN useradd --system --uid 10001 cloudpilot
COPY --from=build /src/apps/web/.next/standalone ./
COPY --from=build /src/apps/web/.next/static apps/web/.next/static
USER cloudpilot
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
