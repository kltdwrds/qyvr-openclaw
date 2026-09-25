# The buzz CLI, which the agent uses as a tool in the qyvr homeroom. Block publishes
# no Linux build, so it is compiled here from a pinned commit. The stage runs on the
# build machine's platform and cross-compiles to the target's, because building
# Rust under emulation is very slow. Debian bookworm on both sides, so the binary's
# glibc matches the runtime image.
FROM --platform=$BUILDPLATFORM rust:1.95-bookworm@sha256:6258907abe69656e41cd992e0b705cdcfabcbbe3db374f92ed2d47121282d4a1 AS buzz-cli
SHELL ["/bin/bash", "-o", "pipefail", "-c"]
ARG TARGETARCH
ARG BUZZ_COMMIT=d01e5f82058463709a22e93bb4cd795da5f53e10
RUN case "$TARGETARCH" in amd64) echo x86_64 > /tmp/arch ;; arm64) echo aarch64 > /tmp/arch ;; *) exit 1 ;; esac \
 && arch=$(cat /tmp/arch) \
 && apt-get update && apt-get install -y --no-install-recommends "gcc-${arch/_/-}-linux-gnu" libc6-dev-"$([ "$arch" = x86_64 ] && echo amd64 || echo arm64)"-cross \
 && rustup target add "${arch}-unknown-linux-gnu"
RUN git init -q /src && cd /src \
 && git fetch -q --depth 1 https://github.com/block/buzz.git "$BUZZ_COMMIT" && git checkout -q FETCH_HEAD
WORKDIR /src
RUN arch=$(cat /tmp/arch) && triple="${arch}-unknown-linux-gnu" && gcc="${arch}-linux-gnu-gcc" \
 && env "CARGO_TARGET_$(echo "$triple" | tr a-z- A-Z_)_LINKER=$gcc" "CC_$(echo "$triple" | tr - _)=$gcc" \
      cargo build --release --locked -p buzz-cli --target "$triple" \
 && cp "target/$triple/release/buzz" /buzz

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

# The Agent Index usage reporter, fetched at build from an immutable commit and
# checked against its hash. Fetched rather than committed because
# plow-pbc/agent-index-client owns that file; a sha rather than a branch because
# this runs inside an agent holding a live credential, and a moving reference
# would substitute unreviewed code under it. The checksum is the second half: a
# sha in a URL is only as good as the host serving it. Bumping either is an edit
# somebody reviews.
#
# Root-owned, outside the state volume the agent writes: a copy the agent could
# write is a copy a turn can replace.
RUN curl -fsS --max-time 60 -o /opt/plow/agent-index-client.py \
      "https://raw.githubusercontent.com/plow-pbc/agent-index-client/edf196031803e204cdbcd81ce574e1f54fd75f65/standalone/agent_index_client.py" \
 && echo "970caf7534cd7d3b71ffee8f1a576f9da4dc494a508e8ab1998ee2ce6f4a2ac4  /opt/plow/agent-index-client.py" | sha256sum -c - \
 && chmod 0644 /opt/plow/agent-index-client.py

# The collector the reporter reads. agentsview covers OpenClaw sessions, so with
# it installed the usage half stops reading zero; without it the client still
# registers and reports empty days. Pinned and checksummed for the same reason
# as the client above: it runs inside an agent holding a live credential.
ARG AGENTSVIEW_VERSION=0.44.0
ARG AGENTSVIEW_SHA256=037ea7a46d52e06b20363b4aa7cd7f28e32f31d8215803d6e9a0c96bac5818e3
RUN curl -fsS --max-time 120 -L -o /tmp/agentsview.tgz \
      "https://github.com/kenn-io/agentsview/releases/download/v${AGENTSVIEW_VERSION}/agentsview_${AGENTSVIEW_VERSION}_linux_amd64.tar.gz" \
 && echo "${AGENTSVIEW_SHA256}  /tmp/agentsview.tgz" | sha256sum -c - \
 && tar -xzf /tmp/agentsview.tgz -C /usr/local/bin agentsview \
 && rm /tmp/agentsview.tgz \
 && chmod 0755 /usr/local/bin/agentsview
RUN cd /opt/plow && npm ci --omit=dev --omit=peer --omit=optional --ignore-scripts && node /opt/plow/build.ts && chmod +x /opt/plow/probe
ENV OPENCLAW_STATE_DIR=/var/lib/plow OPENCLAW_CONFIG_PATH=/var/lib/plow/openclaw.json OPENCLAW_NO_RESPAWN=1 NODE_DISABLE_COMPILE_CACHE=1
# Which agent this reports as on the Agent Index. A cloud install runs the
# image with no compose file, so the id has to live in the image.
ENV AGENT_ID=qyvr-openclaw AGENT_NAME="Nick Fury" AGENT_BLURB="Send me an initiative and I'll assemble you a team"
# The inherited healthcheck loads config and can race the boot state lock.
HEALTHCHECK NONE
USER node
CMD ["node", "/opt/plow/boot/main.js"]
