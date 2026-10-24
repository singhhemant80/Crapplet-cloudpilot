# API + worker image (same image, different command).
FROM node:22-bookworm-slim AS build
WORKDIR /src
COPY package.json package-lock.json ./
COPY packages/hypervisor-sdk/package.json packages/hypervisor-sdk/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --workspace @cloudpilot/hypervisor-sdk --workspace @cloudpilot/api --include-workspace-root
COPY tsconfig.base.json ./
COPY packages/hypervisor-sdk packages/hypervisor-sdk
COPY apps/api apps/api
RUN npm run build -w @cloudpilot/hypervisor-sdk && npm run build -w @cloudpilot/api \
 && npm prune --omit=dev --workspace @cloudpilot/hypervisor-sdk --workspace @cloudpilot/api

FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
RUN useradd --system --uid 10001 cloudpilot
COPY --from=build /src/node_modules node_modules
COPY --from=build /src/packages/hypervisor-sdk/package.json packages/hypervisor-sdk/
COPY --from=build /src/packages/hypervisor-sdk/dist packages/hypervisor-sdk/dist
COPY --from=build /src/apps/api/package.json apps/api/
COPY --from=build /src/apps/api/dist apps/api/dist
COPY --from=build /src/apps/api/drizzle apps/api/drizzle
USER cloudpilot
WORKDIR /app/apps/api
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:4000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]
