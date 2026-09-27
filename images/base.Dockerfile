# Base image for aidev agents: Node and the Claude Code CLI, run as a non-root user.
FROM node:24-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl file git jq less procps ripgrep unzip xz-utils zip \
 && rm -rf /var/lib/apt/lists/*

ARG CLAUDE_CODE_VERSION=latest
RUN npm install -g --allow-scripts=@anthropic-ai/claude-code "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
 && npm cache clean --force

# Job folders are bind-mounted from the Windows host, so git sees a different owner.
RUN git config --system --add safe.directory '*'

# /work is the job's clone and /claude holds the session, so it outlives the container.
RUN mkdir /work /claude && chown node:node /work /claude
ENV CLAUDE_CONFIG_DIR=/claude \
    DISABLE_AUTOUPDATER=1

# "node" (uid 1000) comes with the Node image. --dangerously-skip-permissions refuses to run as root.
USER node
WORKDIR /work
