// src/pages/batReview/utils.ts
import type { BaseImage, MaskType, ReviewPayload } from "./types";

/** Safe numeric parse */
export function toNum(v: any): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const x = parseFloat(v);
    return Number.isFinite(x) ? x : null;
  }
  return null;
}

/** Base64 (nii.gz) -> objectURL */
export function base64ToObjectUrl(b64: string, label: string) {
  if (!b64 || typeof b64 !== "string") throw new Error(`Missing base64 for: ${label}`);
  const clean = b64.replace(/[\r\n\s]/g, "");
  const bin = atob(clean);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const blob = new Blob([bytes], { type: "application/gzip" }); // nii.gz
  return URL.createObjectURL(blob);
}

export function getBaseInfo(payload: ReviewPayload, chosen: BaseImage) {
  const n = payload.nifti || {};
  const hasFF = !!n.ff_b64;
  const effective: BaseImage = chosen === "ff" && !hasFF ? "fat" : chosen;

  const b64 = effective === "ff" ? n.ff_b64 : n.image_b64;
  const name =
    effective === "ff"
      ? n.ff_name || "fat_fraction.nii.gz"
      : n.image_name || "fat.nii.gz";

  return { effective, b64, name, hasFF };
}

export function getMaskInfo(payload: ReviewPayload, mask: MaskType) {
  const n = payload.nifti || {};
  if (mask === "binary") return { b64: n.binary_b64, name: n.binary_name || "binary_bat.nii.gz" };
  if (mask === "c3") return { b64: n.class3_b64, name: n.class3_name || "bat_3class.nii.gz" };
  return { b64: n.class4_b64, name: n.class4_name || "bat_4class.nii.gz" };
}

/**
 * Official Niivue drawing colormap object:
 * nv.setDrawColormap({ R:[], G:[], B:[], labels:[] })
 * :contentReference[oaicite:3]{index=3}
 */
export function makeDrawColormap(mask: MaskType) {
  // indices correspond to label values in the mask
  // label 0 = background (transparent-ish by opacity control, but color can be 0,0,0)
  // Required:
  // class1 Red, class2 Green, class3 Blue, class4 Yellow
  // binary -> label1 Red only

  if (mask === "binary") {
    return {
      R: [0, 255],
      G: [0, 0],
      B: [0, 0],
      labels: ["Background", "BAT (Binary)"],
    };
  }

  if (mask === "c3") {
    return {
      R: [0, 255, 0, 0],
      G: [0, 0, 255, 0],
      B: [0, 0, 0, 255],
      labels: ["Background", "Class 1", "Class 2", "Class 3"],
    };
  }

  // c4
  return {
    R: [0, 255, 0, 0, 255],
    G: [0, 0, 255, 0, 255],
    B: [0, 0, 0, 255, 0],
    labels: ["Background", "Class 1", "Class 2", "Class 3", "Class 4"],
  };
}

export const COLORS = {
  red: "#ff0000",
  green: "#00ff00",
  blue: "#0000ff",
  yellow: "#ffff00",
};