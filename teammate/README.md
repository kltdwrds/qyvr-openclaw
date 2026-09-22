# Team image

The teammate shape runs a local identity adapter in front of the pinned OpenClaw
Control UI. Plow authenticates people and authorizes host membership. OpenClaw
creates their profiles and enforces native scopes. The creator has administration;
other members can read, write, approve actions, and answer questions. Memory and
session-tool visibility use OpenClaw defaults.

Build the base, then this thin layer:

```sh
docker build -t plow-openclaw .
docker build --build-arg BASE=plow-openclaw -t plow-openclaw-team teammate
```

Supply the base image's Plow configuration and these required deployment values:

| Variable | Value |
| --- | --- |
| `PLOW_HOST_ID` | Host ID expected in the assertion audience |
| `PLOW_CREATOR_ID` | Stable creator account ID supplied by Plow, matching its assertion subject |
| `PLOW_DASHBOARD_ORIGIN` | Exact public HTTP(S) origin, with no trailing slash |
| `PLOW_ADAPTER_PORT` | Adapter ingress port, distinct from 18789 |
| `PLOW_ASSERTION_ISSUER` | Expected Plow assertion issuer |
| `PLOW_ASSERTION_JWKS_FILE` | Mounted public Ed25519 JWKS file; each key has a `kid` |

Publish only the adapter port. OpenClaw listens on loopback port 18789, trusts
127.0.0.1 with explicit `allowLoopback`, and has no shared gateway token in the team
configuration. Plow must ensure the creator is the first person to reach a fresh
host. `PLOW_CREATOR_ID` is deployment metadata from Plow, never a caller-selected
admin or a roster-entry ID. The adapter runs with the gateway; its process exits
if the gateway exits. The persistent volume retains native profiles and devices. Team boot creates config
and instructions only when absent, preserving customization. If deployment identity
or origin changes, update the persisted gateway configuration to match before
restarting. Public assertion keys reload from the mounted file on restart.

## Assertion contract

Each HTTP request and WebSocket upgrade carries `X-Plow-Assertion`, an EdDSA JWT
with `kid`, `iss`, `aud` (host ID), `sub` (stable account ID), `iat`, `exp`, and
`client_ip`. Assertions last at most 60 seconds. `client_ip` is the actual client
IP attested by Plow's trusted ingress. The adapter verifies the signature, issuer,
audience and times, consumes the assertion, and reconstructs identity, scope and
forwarding headers. It passes signed loopback addresses unchanged so OpenClaw's
own attribution check rejects them. It never substitutes a synthetic address.

The dashboard origin is fixed by deployment. A supplied browser Origin must
match it. HTTP bodies stream; WebSocket upgrades tunnel bytes. Sockets close at
assertion expiry; reconnects need a fresh assertion. Assertions are bearer
credentials and can be replayed until expiry. Plow must block new requests and
close active connections on membership revocation. Rotate by deploying an
overlapping public key set and restarting the image, then remove the old key
and restart after outstanding assertions expire. Private signing keys stay in
Plow. Plow consumes its own login cookie before forwarding; native OpenClaw
cookies pass through the adapter.

Local processes that can reach the gateway can impersonate the adapter. This
is one trusted team's control plane, not isolation from hostile VM code.
Channel sender IDs and browser profiles are not assumed to be linked.

## Local test signer

The signer stands in for Plow assertion issuance. It supplies fixture identities and signs the client address observed by the test
ingress; it does not implement login or membership.
Keep the private file outside the image and source tree:

```sh
node teammate/sign-test-assertion.mjs init /tmp/team-private.json /tmp/team-public.json
node teammate/sign-test-assertion.mjs sign /tmp/team-private.json test-ingress test-host account-creator CLIENT_IP
```

Configure the adapter with the corresponding issuer, host and public file. A
scripted browser client adds the signed assertion on every request and upgrade.
Use the real non-loopback address observed by the test ingress for `CLIENT_IP`.
A loopback client must fail attribution; do not substitute an invented address.
Remove the test keys after use.

The local proof covers a scripted browser → adapter → pinned OpenClaw in Docker.
Plow login, membership, assertion issuance and the hosting transport are stubbed.
The complete Browser → Plow → host → adapter deployment remains **proposed, not
validated** until that chain passes the release gate, including alternate ingress
paths and revocation. Rerun it on each OpenClaw upgrade.

## QA on the local DTU stack

Mint `plow-credentials` against the local Plow API with the normal `plow-agents`
flow; its API address must be reachable from the container. Use a dedicated
synthetic owner and line through the LINQ twin. Put the team deployment variables
above in `team.env` and set `PLOW_ASSERTION_JWKS_FILE=/run/plow-public.json` there.
Then both doors run in the same image:

```sh
docker run -d --name team-adapter-qa --env-file plow-credentials --env-file team.env \
  -p "127.0.0.1:${PLOW_ADAPTER_PORT}:${PLOW_ADAPTER_PORT}" \
  -v team-adapter-qa-state:/var/lib/plow \
  -v /tmp/team-public.json:/run/plow-public.json:ro plow-openclaw-team
docker logs -f team-adapter-qa
```

Export `PLOW_ADAPTER_PORT` in the shell as well as setting it in `team.env`.
Send a twin inbound to the owner conversation and retain the twin's real model
reply transcript. Against that same container, exercise the dashboard with
creator and member assertions, signed device enrollment, reconnect, an upload,
and invalid assertions. Capture gateway connect logs and browser RPC frames.
Only assertion issuance and the hosting ingress are stubbed in this combined
proof; the Plow channel and model use the DTU stack. The component-only browser
fixture is insufficient evidence for this combined gate.

```sh
docker rm -f team-adapter-qa
docker volume rm team-adapter-qa-state
rm /tmp/team-private.json /tmp/team-public.json
```

Revoke the synthetic agent credential and remove local image tags after QA.
