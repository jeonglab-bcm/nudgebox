# gh.bioinfolder.com. Node 24 runs the TypeScript directly (type stripping), so there
# is no build step; dev dependencies (tsx, typescript) stay out of the image.
FROM node:24-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY src ./src
COPY public ./public
COPY config.yaml ./
USER node
ENV NODE_ENV=production DB_PATH=/data/gh-dashboard.sqlite
EXPOSE 8080 8081
CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.ts"]
