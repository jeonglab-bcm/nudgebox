# gh.bioinfolder.com. Node 24 runs the TypeScript directly (type stripping), so there
# is no build step; dev dependencies (tsx, typescript) stay out of the image.
FROM node:24-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
# SPEC 15: omnidiff (AGPL-3.0, run unmodified as a separate program), pinned and checksum verified;
# scripts/get-omnidiff.sh fetches the same release for development
ADD --checksum=sha256:c85ec5c2f931a52c77aba34211b3c5de377112e8098bdf02a016503856ada1ae https://github.com/ivankovic/omnidiff/releases/download/v0.3.0/omnidiff-x86_64-unknown-linux-musl.tar.gz /tmp/omnidiff.tgz
RUN tar -xzf /tmp/omnidiff.tgz -C /tmp && install -m 0755 "$(find /tmp -name omnidiff -type f | head -1)" /usr/local/bin/omnidiff \
  && rm -rf /tmp/omnidiff* && omnidiff --version
# SPEC 16: resolving conflicts merges file versions with `git merge-file`, as git itself would
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/* && git --version
COPY src ./src
COPY public ./public
COPY config.yaml ./
USER node
ENV NODE_ENV=production DB_PATH=/data/gh-dashboard.sqlite
EXPOSE 8080 8081
CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.ts"]
