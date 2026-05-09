FROM node:22-trixie-slim

RUN apt-get update && apt-get install -y \
    git curl ca-certificates python3 make g++ tmux ssh openssh-client jq \
    ffmpeg zip unzip rsync sqlite3 tree tini sudo \
    && rm -rf /var/lib/apt/lists/*

# Install GitHub CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y gh && rm -rf /var/lib/apt/lists/*

# Install Docker CLI (for remote Docker access via SSH)
RUN curl -fsSL https://download.docker.com/linux/static/stable/$(uname -m)/docker-27.5.1.tgz \
    | tar xz --strip-components=1 -C /usr/local/bin docker/docker \
    && mkdir -p /usr/local/lib/docker/cli-plugins \
    && curl -fsSL "https://github.com/docker/compose/releases/download/v2.32.4/docker-compose-linux-$(uname -m)" \
       -o /usr/local/lib/docker/cli-plugins/docker-compose \
    && chmod +x /usr/local/lib/docker/cli-plugins/docker-compose

# Install Qdrant vector database
RUN curl -fsSL https://github.com/qdrant/qdrant/releases/download/v1.17.1/qdrant-x86_64-unknown-linux-musl.tar.gz \
    | tar xz -C /usr/local/bin && chmod +x /usr/local/bin/qdrant

# Install AI CLIs
# #353 [D4]: pin CLI versions to known-good releases. Upgrade procedure:
#   1. Test on M5 dev with the new tag (one CLI at a time)
#   2. Run the OAuth flow per CLI to confirm the gate-modal still triggers
#   3. Bump here + in `package.json` if applicable, redeploy
RUN npm install -g \
    @anthropic-ai/claude-code@2.1.137 \
    @google/gemini-cli@0.41.2 \
    @openai/codex@0.130.0

# Reuse the existing 'node' user (UID 1000) — rename to workbench, home at /data
# Also hand ownership of the CLI packages to workbench so npm auto-updates work.
# Grant workbench passwordless sudo so the runtime user can install packages
# (e.g. `sudo apt-get install` for chromium runtime libs needed by Playwright)
# without rebuilding the image.
RUN usermod -l workbench -d /data -m node && \
    groupmod -n workbench node && \
    mkdir -p /data/.claude /data/.workbench /data/workspace && \
    chown -R workbench:workbench /data && \
    chown -R workbench:workbench \
        /usr/local/lib/node_modules/@anthropic-ai \
        /usr/local/lib/node_modules/@google \
        /usr/local/lib/node_modules/@openai && \
    echo 'workbench ALL=(ALL) NOPASSWD: ALL' > /etc/sudoers.d/workbench && \
    chmod 0440 /etc/sudoers.d/workbench

# Copy and install app dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && chown -R workbench:workbench /app

# Copy app source
COPY --chown=workbench:workbench . .

# Backwards-compat symlinks: existing /data/.claude/.claude.json files
# (copied between hosts via the dev/prod swap) reference /app/mcp-server.js
# and /app/server.js at the old root locations. Keep them resolvable after
# the move into src/ so we don't have to rewrite every host's MCP config.
RUN ln -s /app/src/mcp-server.js /app/mcp-server.js && \
    ln -s /app/src/server.js /app/server.js

# Entrypoint sets up /data structure at runtime (volume may be empty on first run)
COPY --chown=workbench:workbench entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

USER workbench

ENV HOME=/data
ENV WORKBENCH_DATA=/data/.workbench
ENV WORKSPACE=/data/workspace
ENV CLAUDE_CONFIG_DIR=/data/.claude
ENV PORT=7860

WORKDIR /data
EXPOSE 7860

ENTRYPOINT ["/usr/bin/tini", "--", "/entrypoint.sh"]
CMD ["node", "/app/src/server.js"]
