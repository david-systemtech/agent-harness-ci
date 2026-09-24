/** The part of the Web Crypto API the runtime uses; every platform the runtime runs on has it as `globalThis.crypto`. */
interface RandomSource {
  getRandomValues<T extends Uint8Array>(array: T): T;
}

const random = (): RandomSource => (globalThis as unknown as { crypto: RandomSource }).crypto;

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
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};
