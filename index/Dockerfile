# Nick Fury for anyone who installs him from the Agent Index: no qyvr homeroom; he staffs a team from his bench (Tony
# Stark, Bruce Banner, Natasha Romanoff, standing on Kyle's Plow lines) in one Plow group text. Reports as Nick.
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
    PLOW_TEAM_NUMBERS=+16503156536,+16503156415,+16503156604 PLOW_TEAM_NAMES="Tony Stark,Bruce Banner,Natasha Romanoff"
