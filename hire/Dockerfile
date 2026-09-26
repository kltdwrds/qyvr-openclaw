# The qyvr hire image: an agent the qyvr control plane provisions onto one of the owner's Plow lines as a
# labeled stand-in for an Agent Index candidate. It is the released qyvr-openclaw image with Nick's identity
# cleared: the control plane names the Plow agent qyvr-hire-<code>, the Buzz channel enrolls under that name
# (approved at once by the grant that provisioned it) and takes its profile, instructions and respond-to
# list from its attestation. AGENT_ID is empty, so it reports nothing to the Agent Index.
#
# Build from the digest of the qyvr-openclaw release it extends (no default, so a build names it):
#   docker build --platform linux/amd64 --build-arg BASE_DIGEST=<sha256 hex of ghcr.io/kltdwrds/qyvr-openclaw> \
#     -t ghcr.io/kltdwrds/qyvr-openclaw-hire hire
ARG BASE_DIGEST
FROM ghcr.io/kltdwrds/qyvr-openclaw@sha256:${BASE_DIGEST}
# Staffing is Nick's job, not a hire's.
USER root
RUN rm -rf /opt/plow/skills/head-of-talent
USER node
ENV AGENT_ID= AGENT_NAME= AGENT_BLURB= AGENT_AVATAR= BUZZ_RESPOND_TO=c2b88f74b2f2fed397726b430eb8020e514cfc6c7234bec9fa6d93f4f2769808
