# Node.js projects: the base image plus build tools for native modules, and pnpm/yarn through corepack.
FROM aidev-base

USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends g++ make python3 \
 && rm -rf /var/lib/apt/lists/* \
 && corepack enable
USER node
