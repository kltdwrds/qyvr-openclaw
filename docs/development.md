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
docker run --rm --network none -v "$PWD/tests:/opt/plow/tests:ro" \
  plow-openclaw:test node --test /opt/plow/tests/dependencies.test.ts
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

## 2026.9.5 upgrade notes

The [release](https://github.com/openclaw/openclaw/releases/tag/v2026.9.5)
changes two defaults that our generated config leaves unset:

- [Agent concurrency](https://github.com/openclaw/openclaw/blob/ec9c1a13db8938e5a3eaa51fca2e981cde2395a9/src/config/agent-limits.ts#L5-L20)
  changes from CPU count clamped to 8–16 to four runs per available CPU, with a
  minimum of eight. This is the host's limit; it does not make the Plow transport
  concurrent by itself.
- [Cross-provider messaging](https://github.com/openclaw/openclaw/blob/ec9c1a13db8938e5a3eaa51fca2e981cde2395a9/src/infra/outbound/outbound-policy.ts#L219-L256)
  is allowed unless explicitly disabled. Plow configures only its own channel;
  its adapter still validates the destination's active status and served line.
  Adding another channel would now inherit the more permissive host default.

The channel turn types, private-provider network opt-in, Docker launcher, and
OpenAI-completions stream reducer are unchanged between the pinned releases.
The release's incomplete Anthropic-stream fix is not on our transport path:
both configured model names use Plow's OpenAI-completions proxy.

MCP server types now derive from the validation schema. Our streamable-HTTP
bridge's URL, headers and idle TTL remain supported, and the native catalog
still omits server initialization instructions, so boot's instruction fetch
remains necessary. The Gateway V2 SDK migration concerns node transport APIs
that this plugin does not import. No Plow adapter or configuration migration
is needed for this upgrade.
