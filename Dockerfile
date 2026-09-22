FROM ghcr.io/openclaw/openclaw:2026.9.4@sha256:cc596b846506a5f4cfcee111394a2725f375f01cca2ebb492a161fd1b747f101
ARG PLOW_REVISION
LABEL org.opencontainers.image.revision=$PLOW_REVISION co.plow.probe=/opt/plow/probe
USER root
RUN mkdir -p /opt/plow/skills /var/lib/plow && chown node:node /var/lib/plow
COPY boot /opt/plow/boot
COPY plugin /opt/plow/plugin
COPY prompt /opt/plow/prompt
COPY skills /opt/plow/skills
COPY build.ts /opt/plow/build.ts
COPY package.json package-lock.json tsconfig.json /opt/plow/
RUN cd /opt/plow && npm ci --omit=dev --omit=peer --omit=optional --ignore-scripts && node /opt/plow/build.ts && chmod +x /opt/plow/probe

# The Agent Index reporter, so an agent built on this base reports its usage
# without wiring one up. Both pieces are pinned and checksummed: they run
# inside an agent holding a live credential, and a moved tag or a substituted
# file would be code nobody reviewed.
#
# agentsview is the collector -- it reads OpenClaw's own session files -- and
# it looks for them under ~/.openclaw, which this image keeps in the state
# directory, hence the link.
ARG AGENTSVIEW_VERSION=0.44.0
ARG AGENTSVIEW_SHA256=037ea7a46d52e06b20363b4aa7cd7f28e32f31d8215803d6e9a0c96bac5818e3
ARG AGENT_INDEX_CLIENT_SHA=d1e6641bb8c72c0952c02cb9baf75f6145a3ed92
ARG AGENT_INDEX_CLIENT_SHA256=718db0330f09b5dc72a6f3e53d47e7ea9f28ffd838dc8cb7afe6e3036ce09384
RUN set -eu; \
    curl -fsSL --retry 3 -o /tmp/agentsview.tgz \
      "https://github.com/kenn-io/agentsview/releases/download/v${AGENTSVIEW_VERSION}/agentsview_${AGENTSVIEW_VERSION}_linux_amd64.tar.gz"; \
    echo "${AGENTSVIEW_SHA256}  /tmp/agentsview.tgz" | sha256sum -c -; \
    tar -xzf /tmp/agentsview.tgz -C /usr/local/bin agentsview; \
    rm /tmp/agentsview.tgz; \
    mkdir -p /opt/plow/agent-index; \
    curl -fsSL --retry 3 -o /opt/plow/agent-index/agent_index_client.py \
      "https://raw.githubusercontent.com/plow-pbc/agent-index-client/${AGENT_INDEX_CLIENT_SHA}/standalone/agent_index_client.py"; \
    echo "${AGENT_INDEX_CLIENT_SHA256}  /opt/plow/agent-index/agent_index_client.py" | sha256sum -c -; \
    chmod 0644 /opt/plow/agent-index/agent_index_client.py; \
    install -d -o node -g node /var/lib/plow/agent-index; \
    ln -sfn /var/lib/plow /home/node/.openclaw
ENV OPENCLAW_STATE_DIR=/var/lib/plow OPENCLAW_CONFIG_PATH=/var/lib/plow/openclaw.json OPENCLAW_NO_RESPAWN=1 NODE_DISABLE_COMPILE_CACHE=1
# The inherited healthcheck loads config and can race the boot state lock.
HEALTHCHECK NONE
USER node
CMD ["node", "/opt/plow/boot/main.js"]
