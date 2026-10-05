/** Ticket #1630's bounded width/height matrix; only its leaf scenes use these profiles. */
export const COMPACT_COMPOSER_PROFILES = [
  { suffix: "phone-320", viewport: { width: 320, height: 568 }, textSize: 16 },
  { suffix: "phone-320-short", viewport: { width: 320, height: 320 }, textSize: 16 },
  { suffix: "phone-360", viewport: { width: 360, height: 740 }, textSize: 16 },
  { suffix: "phone-360-short", viewport: { width: 360, height: 400 }, textSize: 16 },
  { suffix: "phone-390", viewport: { width: 390, height: 844 }, textSize: 16 },
  { suffix: "phone-390-keyboard", viewport: { width: 390, height: 480 }, textSize: 16 },
  { suffix: "phone-390-text-20", viewport: { width: 390, height: 844 }, textSize: 20 },
  { suffix: "phone-430", viewport: { width: 430, height: 932 }, textSize: 16 },
  { suffix: "phone-430-short", viewport: { width: 430, height: 360 }, textSize: 16 },
] as const;
