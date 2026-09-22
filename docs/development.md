# Development

The image pins the runtime and SDK. CI type-checks boot, plugin and build sources,
runs all Node tests against that image, and boots the real offline gateway probe.
Tests use local fixtures and need no Plow credentials. Type checking uses the
published OpenClaw 2026.9.5 declarations because the runtime image omits them;
runtime tests use the SDK shipped in the pinned image. The plugin is an npm
workspace: CI and the image use the root lock, with development, peer and optional
dependencies omitted from the image install.

```sh
npm ci
docker build -t plow-openclaw:test .
docker run --rm --user root --network none \
  -v "$PWD/node_modules:/opt/plow/node_modules:ro" \
  -v "$PWD/tests:/opt/plow/tests:ro" plow-openclaw:test sh -c \
  '/opt/plow/node_modules/.bin/tsc --noEmit -p /opt/plow/tsconfig.json && mkdir -p /opt/plow/plugin/node_modules && ln -s /app /opt/plow/plugin/node_modules/openclaw && node --test /opt/plow/tests/*.test.ts'
docker run --rm --network none plow-openclaw:test /opt/plow/probe
```

## Pinned OpenClaw contracts

The Dockerfile pins OpenClaw `2026.9.5` by image digest. These source links target
its release commit `ec9c1a13db8938e5a3eaa51fca2e981cde2395a9`.

| Contract | Source |
| --- | --- |
| Non-root runtime and foreground launcher | [Dockerfile](https://github.com/openclaw/openclaw/blob/ec9c1a13db8938e5a3eaa51fca2e981cde2395a9/Dockerfile#L427-L448) |
| Config environment references | [Environment substitution](https://github.com/openclaw/openclaw/blob/ec9c1a13db8938e5a3eaa51fca2e981cde2395a9/src/config/env-substitution.ts#L99-L145) |
| Private provider endpoint opt-in | [Provider transport](https://github.com/openclaw/openclaw/blob/ec9c1a13db8938e5a3eaa51fca2e981cde2395a9/src/agents/provider-transport-fetch.ts#L666-L693) |
| Channel registration and inbound dispatch | [Plugin entry](https://github.com/openclaw/openclaw/blob/ec9c1a13db8938e5a3eaa51fca2e981cde2395a9/src/plugin-sdk/core.ts#L538-L589), [turn contract](https://github.com/openclaw/openclaw/blob/ec9c1a13db8938e5a3eaa51fca2e981cde2395a9/src/channels/turn/types.ts#L317-L349) |
| Session isolation and owner binding | [Routing schema](https://github.com/openclaw/openclaw/blob/ec9c1a13db8938e5a3eaa51fca2e981cde2395a9/src/config/zod-schema.agents.ts#L92-L137) |
| Tool registration, requester and deny policy | [Tool API](https://github.com/openclaw/openclaw/blob/ec9c1a13db8938e5a3eaa51fca2e981cde2395a9/src/plugins/plugin-api.types.ts#L213-L216), [hook context](https://github.com/openclaw/openclaw/blob/ec9c1a13db8938e5a3eaa51fca2e981cde2395a9/src/plugins/hook-types.ts#L693-L736), [policy schema](https://github.com/openclaw/openclaw/blob/ec9c1a13db8938e5a3eaa51fca2e981cde2395a9/src/config/zod-schema.agent-runtime.ts#L330-L341) |
| MCP configuration | [MCP server schema](https://github.com/openclaw/openclaw/blob/ec9c1a13db8938e5a3eaa51fca2e981cde2395a9/src/config/zod-schema.mcp-server.ts#L15-L36) |
| Native MCP catalog omits server instructions | [Catalog construction](https://github.com/openclaw/openclaw/blob/ec9c1a13db8938e5a3eaa51fca2e981cde2395a9/src/agents/agent-bundle-mcp-runtime.ts#L852-L932) |

## Defaults we inherit

Generated config leaves host agent concurrency and cross-provider messaging
policy unset, so both follow the pinned OpenClaw release's defaults. Review
those defaults when changing the runtime pin or adding channels. Host concurrency
is separate from Plow's per-chat scheduling; Plow's send adapter still validates
that destinations are active and belong to its served lines.
