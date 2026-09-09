// Shared visual tokens for the BAT review workspace.
//
// One place for the palette so the side panels, toolbar and viewer panes agree.
// The scale is a neutral slate ramp on near-black, which keeps the greyscale MRI
// the brightest thing on screen — chrome that competes with the image makes
// low-contrast BAT boundaries harder to judge.

export const C = {
  /** page background, behind everything */
  bg: "#0b0d12",
  /** panel / card surface */
  surface: "#111621",
  /** inset surface: tables, wells, nested cards */
  surfaceInset: "#0a0e17",
  /** the canvas ground — pure black, so nothing tints the image */
  canvas: "#000000",

  border: "#1e2637",
  borderStrong: "#2b3648",

  text: "#f1f5f9",
  textMuted: "rgba(241,245,249,0.68)",
  textFaint: "rgba(241,245,249,0.42)",

  accent: "#7c9cf5",
  accentDim: "#3c5ba8",
  ok: "#34d399",
  warn: "#fbbf24",
  danger: "#f87171",
} as const;

export const BORDER = `1px solid ${C.border}`;

/** Mask class colours — must match makeBatLut() in useNiivue4Up.ts. */
export const CLASS_COLORS = {
  1: "#ff3b30",
  2: "#34c759",
  3: "#0a84ff",
  4: "#ffd60a",
} as const;

export const panelSx = {
  bgcolor: C.surface,
  border: BORDER,
  borderRadius: 2,
} as const;

/** Compact dark toggle-button styling used by the toolbar groups. */
export const toggleSx = {
  color: C.textMuted,
  borderColor: C.border,
  bgcolor: "transparent",
  textTransform: "none",
  fontWeight: 600,
  fontSize: 12,
  px: 1.25,
  "&:hover": { bgcolor: "rgba(124,156,245,0.10)" },
  "&.Mui-selected": {
    color: C.text,
    bgcolor: "rgba(124,156,245,0.20)",
    "&:hover": { bgcolor: "rgba(124,156,245,0.28)" },
  },
  "&.Mui-disabled": { color: C.textFaint, borderColor: "rgba(30,38,55,0.6)" },
} as const;
