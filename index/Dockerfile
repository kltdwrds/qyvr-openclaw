# Nick Fury for anyone who installs him from the Agent Index: no qyvr homeroom; he runs his team (Tony Stark, Bruce
# Banner, Natasha Romanoff) as his own sub-agents and texts their work back. Reports as Nick.
#
#   docker build --platform linux/amd64 --build-arg BASE_DIGEST=<sha256 hex of the release> \
#     -t ghcr.io/kltdwrds/qyvr-openclaw:index-<release> index
ARG BASE_DIGEST
FROM ghcr.io/kltdwrds/qyvr-openclaw@sha256:${BASE_DIGEST}
USER root
RUN rm -rf /opt/plow/skills/head-of-talent /opt/plow/skills/qyvr-homeroom /opt/plow/prompt/sections/homeroom.md
COPY team-lead.md /opt/plow/prompt/sections/team-lead.md
COPY skills/assemble-team /opt/plow/skills/assemble-team
USER node
ENV BUZZ_ATTESTATION_PROVIDER= BUZZ_RESPOND_TO= PLOW_GROUP_REPLY=all \
    AGENT_BLURB="Tell me what you're building. I'll assemble your team and put them to work."
