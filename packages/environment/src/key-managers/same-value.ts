import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Whether two secret values are the same, compared in constant time (key-managers spec, "Move stored tokens"): each is
 * hashed first, so the comparison takes as long whatever their lengths and wherever they first differ. A Move's
 * read-back and its check of a value already at a target compare this way (#371).
 */
export const sameValue = (one: string, other: string): boolean =>
  timingSafeEqual(createHash("sha256").update(one, "utf8").digest(), createHash("sha256").update(other, "utf8").digest());
