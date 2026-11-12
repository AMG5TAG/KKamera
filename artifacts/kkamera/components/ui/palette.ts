/**
 * Shared colour tokens for the dark KKamera UI. Screens historically declare
 * their own PRIMARY/BG/CARD constants; new and touched code should import from
 * here instead. Text tokens are chosen to meet WCAG AA (4.5:1) on BG and CARD.
 */
export const palette = {
  primary: "#b19870",
  secondary: "#c3b091",
  bg: "#0d0b08",
  card: "#1a1710",
  border: "rgba(177,152,112,0.15)",
  text: "#ffffff",
  /** Secondary body text — ~7:1 on BG. */
  textMuted: "#a8a29e",
  /** Tertiary text / captions — ~4.8:1 on CARD, ~5.3:1 on BG. */
  textSubtle: "#8a847c",
  danger: "#ef4444",
  /** Error text readable at small sizes (~6:1 on CARD). */
  dangerText: "#f87171",
  success: "#22c55e",
  warning: "#f59e0b",
} as const;

export type Palette = typeof palette;
