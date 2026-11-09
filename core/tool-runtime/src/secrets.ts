/** Shared macOS lookup: credentials stay in the calling tool's process. */
export { KeychainStore, type SecretStore } from "@leanish/agent-runtime/secret-store";

/** The key stored in Keychain item `service`, as bytes. The message never includes the value. */
export function signingKeyFrom(value: string, service: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new Error(`the Keychain item '${service}' must hold 64 lowercase hexadecimal characters (openssl rand -hex 32)`);
  return Buffer.from(value, "hex");
}
