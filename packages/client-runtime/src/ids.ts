/** The part of the Web Crypto API the runtime uses; every platform the runtime runs on has it as `globalThis.crypto`. */
interface RandomSource {
  getRandomValues<T extends Uint8Array>(array: T): T;
}

const random = (): RandomSource => (globalThis as unknown as { crypto: RandomSource }).crypto;

/** Sixteen bytes as a UUID of `version` (its high nibble: `0x40`, `0x70`) in the RFC 9562 variant, in lowercase hex with its dashes. */
const formatted = (bytes: Uint8Array, version: number): string => {
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | version;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

/**
 * A UUIDv7 for `now` (RFC 9562): 48 bits of milliseconds, then random bits,
 * so ids sort by the time they were made. Command ids are UUIDv7
 * (docs/specs/client-runtime.md, "The offline outbox"), the outbox's (#128)
 * and the direct admin requests' alike.
 */
export const uuidv7 = (now: Date): string => {
  const bytes = random().getRandomValues(new Uint8Array(16));
  let ms = now.getTime();
  for (let i = 5; i >= 0; i--) {
    bytes[i] = ms % 256;
    ms = Math.floor(ms / 256);
  }
  return formatted(bytes, 0x70);
};

/**
 * A version 4 UUID (RFC 9562): what a client mints for a session or a group
 * it creates, which the contracts require to be version 4 (`SessionId`,
 * `GroupId`), so an outbox can queue a command naming it before the
 * environment has seen it.
 */
export const uuidv4 = (): string => formatted(random().getRandomValues(new Uint8Array(16)), 0x40);
