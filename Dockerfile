FROM node:24-bookworm-slim AS web-build
WORKDIR /app
COPY apps/web/package*.json apps/web/
RUN npm --prefix apps/web ci
COPY apps/web apps/web
COPY packages packages
RUN npm --prefix apps/web run build

FROM node:24-bookworm-slim
ENV NODE_ENV=production PORT=3000 DROPVAULT_HOST=0.0.0.0 DROPVAULT_STORAGE_DIR=/data
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY apps/api apps/api
COPY apps/web/src/shared/data/mock-multi-user-drive.json apps/web/src/shared/data/mock-multi-user-drive.json
COPY --from=web-build /app/apps/web/dist apps/web/dist
COPY packages packages
EXPOSE 3000
CMD ["node", "apps/api/src/start-demo.js"]
