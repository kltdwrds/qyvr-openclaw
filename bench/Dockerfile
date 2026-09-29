# One of Nick Fury's team (Tony Stark, Bruce Banner, Natasha Romanoff): a standing agent on one of Kyle's Plow lines that
# works in the group texts Nick starts for whoever installed him. It reports as Nick, answers only when named, and runs
# locked down (no tools, skills, Mac bridge or heartbeat), because strangers direct it.
#
#   docker build --platform linux/amd64 --build-arg BASE_DIGEST=<sha256 hex of the release> \
#     --build-arg MEMBER=tony --build-arg MEMBER_NAME="Tony Stark" -t ghcr.io/kltdwrds/qyvr-openclaw:bench-tony-<release> bench
ARG BASE_DIGEST
FROM ghcr.io/kltdwrds/qyvr-openclaw@sha256:${BASE_DIGEST}
ARG MEMBER
ARG MEMBER_NAME
USER root
RUN rm -rf /opt/plow/skills/* /opt/plow/prompt/sections/homeroom.md
COPY bench.md /opt/plow/prompt/sections/bench.md
COPY ${MEMBER}.md /opt/plow/prompt/sections/member.md
USER node
ENV AGENT_NAME=${MEMBER_NAME} AGENT_BLURB= AGENT_AVATAR= BUZZ_ATTESTATION_PROVIDER= BUZZ_RESPOND_TO= \
    PLOW_GROUP_REPLY=named PLOW_LOCKDOWN=1 PLOW_TEAM_NUMBERS=+16503156536,+16503156415,+16503156604
