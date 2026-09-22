// Local test signer. Never copy its private key into an agent image.
import { readFile, writeFile } from "node:fs/promises";
import { exportJWK, generateKeyPair, importJWK, SignJWT } from "jose";

const [command, keyFile, ...args] = process.argv.slice(2);
if (command === "init" && keyFile && args.length === 1) {
  const { privateKey, publicKey } = await generateKeyPair("EdDSA", { extractable: true });
  await writeFile(keyFile, JSON.stringify(await exportJWK(privateKey)), { mode: 0o600, flag: "wx" });
  await writeFile(args[0], JSON.stringify({ keys: [{ ...await exportJWK(publicKey), kid: "local-test" }] }), { flag: "wx" });
} else if (command === "sign" && keyFile && args.length === 4) {
  const [issuer, host, person, clientIp] = args;
  const key = await importJWK(JSON.parse(await readFile(keyFile, "utf8")), "EdDSA");
  const assertion = await new SignJWT({ client_ip: clientIp }).setProtectedHeader({ alg: "EdDSA", kid: "local-test" })
    .setIssuer(issuer).setAudience(host).setSubject(person).setIssuedAt().setExpirationTime("60s").sign(key);
  process.stdout.write(assertion);
} else {
  throw new Error("Usage: sign-test-assertion.mjs init PRIVATE.json PUBLIC.json | sign PRIVATE.json ISSUER HOST PERSON CLIENT_IP");
}
