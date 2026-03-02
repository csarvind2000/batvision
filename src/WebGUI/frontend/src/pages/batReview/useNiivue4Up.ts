// src/pages/BatReview/useNiivue4Up.ts
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Niivue, NVImage } from "@niivue/niivue";
import { base64NiftiToObjectUrl } from "../../utils/niivueBase64";

export type MaskType = "binary" | "c3" | "c4";
export type EditMode = "off" | "draw" | "erase";

type LoadBaseArgs = { b64: string; name: string };

type LoadMaskArgs = {
  key: string;
  opacity: number; // 0..1
  lut?: Uint8Array;
  maskUrl?: string;
  maskB64?: string;
  name?: string;
};

type Nv4 = {
  axial: Niivue;
  sagittal: Niivue;
  coronal: Niivue;
  render3D: Niivue;
};

function hasWebGL(): boolean {
  try {
    const c = document.createElement("canvas");
    return !!(c.getContext("webgl2") || c.getContext("webgl"));
  } catch {
    return false;
  }
}

/** LUT builder (RGBA x 256) */
export function makeBatLut(mask: MaskType): Uint8Array {
  const lut = new Uint8Array(256 * 4);
  lut[0] = 0; lut[1] = 0; lut[2] = 0; lut[3] = 0;

  const set = (label: number, r: number, g: number, b: number, a: number) => {
    const i = label * 4;
    lut[i] = r; lut[i + 1] = g; lut[i + 2] = b; lut[i + 3] = a;
  };

  if (mask === "binary") {
    set(1, 255, 0, 0, 255);
  } else if (mask === "c3") {
    set(1, 255, 0, 0, 255);
    set(2, 0, 255, 0, 255);
    set(3, 0, 0, 255, 255);
  } else {
    set(1, 255, 0, 0, 255);
    set(2, 0, 255, 0, 255);
    set(3, 0, 0, 255, 255);
    set(4, 255, 255, 0, 255);
  }
  return lut;
}

function safeSize(el: HTMLCanvasElement | null) {
  if (!el) return null;
  return `${el.clientWidth}x${el.clientHeight}`;
}

function clamp01(x: number) {
  if (!Number.isFinite(x)) return 1;
  return Math.max(0, Math.min(1, x));
}

/** base64 -> Uint8Array (supports raw base64 OR data:...;base64,...) */
function base64ToBytes(b64: string): Uint8Array {
  if (!b64) return new Uint8Array();
  const clean = b64
    .trim()
    .replace(/\s/g, "")
    .replace(/^data:.*;base64,/, "");
  const bin = atob(clean);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Fetch URL -> Uint8Array */
async function fetchToBytes(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Mask fetch failed: ${res.status} ${res.statusText}`);
  return new Uint8Array(await res.arrayBuffer());
}

function sniffBytes(label: string, bytes: Uint8Array) {
  const head = Array.from(bytes.slice(0, 16))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join(" ");
  const isGzip = bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
  console.log(`[SNIFF] ${label}`, { len: bytes.length, head, isGzip });
  return { isGzip, len: bytes.length, head };
}

/**
 * ✅ No glasbey dependency.
 * Apply LUT safely across Niivue builds.
 */
function applyDrawLutSafe(nv: any, lut?: Uint8Array) {
  if (!lut) return;
  try {
    if (!nv.drawLut || typeof nv.drawLut !== "object") {
      nv.drawLut = { lut: lut, labels: new Array(256).fill("") };
    }
    if (nv.drawLut && typeof nv.drawLut === "object") {
      nv.drawLut.lut = lut;
      if (!nv.drawLut.labels) nv.drawLut.labels = new Array(256).fill("");
      if (Array.isArray(nv.drawLut.labels) && nv.drawLut.labels.length < 256) {
        nv.drawLut.labels = [
          ...nv.drawLut.labels,
          ...new Array(256 - nv.drawLut.labels.length).fill(""),
        ];
      }
    } else {
      nv.drawLut = lut;
    }
    nv.refreshDrawing?.();
    nv.drawScene?.();
  } catch (e) {
    console.warn("[NV] applyDrawLutSafe failed", e);
  }
}

/**
 * Best-effort: set location (world mm) across builds.
 */
function setLocationBestEffort(target: any, mm: number[]) {
  const [x, y, z] = mm;

  try { if (typeof target.setCrosshairPos === "function") { target.setCrosshairPos(x, y, z); return; } } catch {}
  try { if (typeof target.setCrosshairXYZ === "function") { target.setCrosshairXYZ(x, y, z); return; } } catch {}
  try { if (typeof target.setSliceMM === "function") { target.setSliceMM(x, y, z); return; } } catch {}
  try { if (typeof target.setLocation === "function") { target.setLocation([x, y, z]); return; } } catch {}
}

/**
 * Best-effort: read current location mm across builds.
 */
function getLocationMMBestEffort(v: any): number[] | null {
  // many builds keep v.crosshairPos in mm
  try {
    const p = v?.crosshairPos;
    if (Array.isArray(p) && p.length >= 3) return [p[0], p[1], p[2]];
  } catch {}

  // some builds expose getCrosshairPos()
  try {
    if (typeof v.getCrosshairPos === "function") {
      const p = v.getCrosshairPos();
      if (Array.isArray(p) && p.length >= 3) return [p[0], p[1], p[2]];
    }
  } catch {}

  // some builds store location in v.scene?.crosshairPos
  try {
    const p = v?.scene?.crosshairPos;
    if (Array.isArray(p) && p.length >= 3) return [p[0], p[1], p[2]];
  } catch {}

  return null;
}

/**
 * Load drawing robustly:
 * - Prefer bytes if supported
 * - Fallback: objectURL and use loadDrawingFromUrl({url})
 */
async function loadDrawingRobust(v: any, bytes: Uint8Array, name = "mask.nii.gz") {
  // Some builds accept bytes directly
  try {
    if (typeof v.loadDrawingFromUrl === "function") {
      await v.loadDrawingFromUrl(bytes);
      return;
    }
  } catch {}

  const blob = new Blob([bytes], { type: "application/gzip" });
  const url = URL.createObjectURL(blob);
  try {
    if (typeof v.loadDrawingFromUrl === "function") {
      await v.loadDrawingFromUrl({ url, name });
      return;
    }
    if (typeof v.loadDrawing === "function") {
      await v.loadDrawing({ url, name });
      return;
    }
    throw new Error("No supported drawing loader on this Niivue build.");
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Throttle sync work to animation frames (smooth scroll).
 */
function makeRafThrottler() {
  let scheduled = false;
  let lastArgs: any[] | null = null;

  return (fn: (...args: any[]) => void, ...args: any[]) => {
    lastArgs = args;
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      const a = lastArgs;
      lastArgs = null;
      if (a) fn(...a);
    });
  };
}

export function useNiivue4Up() {
  const axialRef = useRef<HTMLCanvasElement | null>(null);
  const sagittalRef = useRef<HTMLCanvasElement | null>(null);
  const coronalRef = useRef<HTMLCanvasElement | null>(null);
  const render3DRef = useRef<HTMLCanvasElement | null>(null);

  const refs = useMemo(
    () => ({ axialRef, sagittalRef, coronalRef, render3DRef }),
    []
  );

  const [viewerOk] = useState(() => {
    const ok = hasWebGL();
    console.log("[NV] hasWebGL:", ok);
    return ok;
  });

  const [attachReady, setAttachReady] = useState(false);
  const nvRef = useRef<Nv4 | null>(null);

  // base URL cleanup (objectURL)
  const baseUrlCleanupRef = useRef<null | (() => void)>(null);

  // mask cache
  const maskBytesCacheRef = useRef<Map<string, Uint8Array>>(new Map());

  // prevent recursion loops
  const syncingRef = useRef(false);

  // throttlers for sync
  const rafSync = useRef(makeRafThrottler());

  const forceResizeAndDraw = useCallback(() => {
    const nv = nvRef.current;
    if (!nv) return;
    try {
      nv.axial.resizeListener();
      nv.sagittal.resizeListener();
      nv.coronal.resizeListener();
      nv.render3D.resizeListener();

      nv.axial.drawScene();
      nv.sagittal.drawScene();
      nv.coronal.drawScene();
      nv.render3D.drawScene();
    } catch (e) {
      console.warn("[NV] forceResizeAndDraw failed:", e);
    }
  }, []);

  // ---------------- attach 4 viewers ----------------
  useEffect(() => {
    if (!viewerOk) return;
    if (attachReady) return;

    let cancelled = false;

    const tryAttach = async () => {
      const a = axialRef.current;
      const s = sagittalRef.current;
      const c = coronalRef.current;
      const r = render3DRef.current;

      console.log("[NV] attach probe", {
        hasA: !!a, hasS: !!s, hasC: !!c, hasR: !!r,
        aSize: safeSize(a), sSize: safeSize(s), cSize: safeSize(c), rSize: safeSize(r),
      });

      if (!a || !s || !c || !r) {
        if (!cancelled) setTimeout(tryAttach, 50);
        return;
      }

      const mk = () =>
        new Niivue({
          isColorbar: false,
          isOrientCube: false,
          isRuler: false,
          isCrosshair: true,
          show3Dcrosshair: false,
          backColor: [0.06, 0.07, 0.09, 1],
        });

      const axial = mk();
      const sagittal = mk();
      const coronal = mk();
      const render3D = mk();

      try {
        await axial.attachToCanvas(a);
        await sagittal.attachToCanvas(s);
        await coronal.attachToCanvas(c);
        await render3D.attachToCanvas(r);

        axial.setSliceType(axial.sliceTypeAxial);
        sagittal.setSliceType(sagittal.sliceTypeSagittal);
        coronal.setSliceType(coronal.sliceTypeCoronal);
        render3D.setSliceType(render3D.sliceTypeRender);

        nvRef.current = { axial, sagittal, coronal, render3D };
        setAttachReady(true);

        console.log("[NV] attached all 4 viewers");
        forceResizeAndDraw();
      } catch (e) {
        console.error("[NV] attach failed:", e);
      }
    };

    tryAttach();
    return () => { cancelled = true; };
  }, [viewerOk, attachReady, forceResizeAndDraw]);

  useEffect(() => {
    if (!attachReady) return;
    const onResize = () => forceResizeAndDraw();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [attachReady, forceResizeAndDraw]);

  // ---------------- FULL SYNC: crosshair + scroll ----------------
  useEffect(() => {
    if (!attachReady) return;
    const nv = nvRef.current;
    if (!nv) return;

    const viewers: any[] = [nv.axial, nv.sagittal, nv.coronal, nv.render3D];

    const broadcastMM = (srcIdx: number, mm: number[]) => {
      if (syncingRef.current) return;
      syncingRef.current = true;

      try {
        viewers.forEach((dst, dstIdx) => {
          if (dstIdx === srcIdx) return;
          setLocationBestEffort(dst, mm);
          dst.drawScene?.();
        });
      } finally {
        syncingRef.current = false;
      }
    };

    const hook = (v: any, idx: number) => {
      // 1) Crosshair move (mouse move/click)
      try {
        v.onLocationChange = (loc: any) => {
          const mm: number[] | undefined = loc?.mm;
          if (!mm || mm.length < 3) return;
          rafSync.current(broadcastMM, idx, [mm[0], mm[1], mm[2]]);
        };
      } catch {}

      // 2) Scroll / slice change (wheel)
      // Different builds: onSliceChange can be number or object.
      try {
        v.onSliceChange = (_arg: any) => {
          const mm = getLocationMMBestEffort(v);
          if (!mm) return;
          rafSync.current(broadcastMM, idx, mm);
        };
      } catch {}

      // 3) Extra fallback: patch setSliceMM / setCrosshairPos so ANY internal change syncs
      // This catches cases where Niivue doesn’t fire the callbacks on wheel.
      const patchFn = (fnName: string) => {
        const orig = v[fnName];
        if (typeof orig !== "function") return () => {};
        if (orig.__patchedSync) return () => {}; // already patched

        const wrapped = (...args: any[]) => {
          const ret = orig.apply(v, args);
          try {
            const mm = getLocationMMBestEffort(v);
            if (mm) rafSync.current(broadcastMM, idx, mm);
          } catch {}
          return ret;
        };
        wrapped.__patchedSync = true;
        v[fnName] = wrapped;
        return () => { v[fnName] = orig; };
      };

      const unpatch1 = patchFn("setSliceMM");
      const unpatch2 = patchFn("setCrosshairPos");
      const unpatch3 = patchFn("setCrosshairXYZ");
      const unpatch4 = patchFn("setLocation");

      return () => {
        try { v.onLocationChange = null; } catch {}
        try { v.onSliceChange = null; } catch {}
        unpatch1(); unpatch2(); unpatch3(); unpatch4();
      };
    };

    const cleanups = viewers.map((v, i) => hook(v, i));

    return () => { cleanups.forEach((c) => { try { c(); } catch {} }); };
  }, [attachReady]);

  // ---------------- base load ----------------
  const loadBaseFromB64 = useCallback(
    async ({ b64, name }: LoadBaseArgs) => {
      const nv = nvRef.current;
      if (!nv) throw new Error("Viewer not ready (nvRef null)");
      if (!b64?.trim()) throw new Error("Base image b64 is empty");

      if (baseUrlCleanupRef.current) {
        try { baseUrlCleanupRef.current(); } catch {}
        baseUrlCleanupRef.current = null;
      }

      const { url, cleanup } = base64NiftiToObjectUrl(b64, "application/gzip");
      baseUrlCleanupRef.current = cleanup;

      const base = await NVImage.loadFromUrl({ url, name });

      await nv.axial.loadVolumes([base]);
      await nv.sagittal.loadVolumes([base]);
      await nv.coronal.loadVolumes([base]);
      await nv.render3D.loadVolumes([base]);

      // After loading base, force all to same location (prevents desync on first scroll)
      const mm = getLocationMMBestEffort(nv.axial as any) || [0, 0, 0];
      setLocationBestEffort(nv.sagittal as any, mm);
      setLocationBestEffort(nv.coronal as any, mm);
      setLocationBestEffort(nv.render3D as any, mm);

      forceResizeAndDraw();
    },
    [forceResizeAndDraw]
  );

  // ---------------- mask unload ----------------
  const unloadMask = useCallback(() => {
    const nv = nvRef.current;
    if (!nv) return;

    try { (nv.axial as any).closeDrawing?.(); } catch {}
    try { (nv.sagittal as any).closeDrawing?.(); } catch {}
    try { (nv.coronal as any).closeDrawing?.(); } catch {}
    try { (nv.render3D as any).closeDrawing?.(); } catch {}

    forceResizeAndDraw();
  }, [forceResizeAndDraw]);

  // ---------------- mask load ----------------
  const loadMask = useCallback(
    async ({ key, opacity, lut, maskUrl, maskB64, name }: LoadMaskArgs) => {
      const nv = nvRef.current;
      if (!nv) throw new Error("Viewer not ready (nvRef null)");
      if (nv.axial.volumes.length === 0) throw new Error("Base not loaded yet.");

      if (!key?.trim()) {
        console.warn("[NV] loadMask called with empty key -> unload");
        unloadMask();
        return;
      }
      if (!maskUrl && !maskB64) {
        console.warn("[NV] loadMask called without data -> unload", { key });
        unloadMask();
        return;
      }

      unloadMask();

      let bytes = maskBytesCacheRef.current.get(key);
      if (!bytes) {
        bytes = maskUrl ? await fetchToBytes(maskUrl) : base64ToBytes(maskB64!);
        maskBytesCacheRef.current.set(key, bytes);
      }

      const sniff = sniffBytes(`mask:${key}`, bytes);
      if (!sniff.isGzip) {
        console.error("[NV] mask not gzip", sniff);
        throw new Error(
          `Mask is not a gzipped NIfTI (.nii.gz). head=${sniff.head}. Backend must return real .nii.gz bytes.`
        );
      }

      const viewers: any[] = [nv.axial, nv.sagittal, nv.coronal, nv.render3D];

      await Promise.all(
        viewers.map(async (v) => {
          await loadDrawingRobust(v, bytes, name || "mask.nii.gz");
          v.setDrawOpacity?.(clamp01(opacity));
          applyDrawLutSafe(v, lut);
          v.refreshDrawing?.();
          v.drawScene?.();
        })
      );

      forceResizeAndDraw();
    },
    [unloadMask, forceResizeAndDraw]
  );

  const setMaskOpacity = useCallback(
    (opacity: number) => {
      const nv = nvRef.current;
      if (!nv) return;
      const o = clamp01(opacity);
      try { (nv.axial as any).setDrawOpacity?.(o); } catch {}
      try { (nv.sagittal as any).setDrawOpacity?.(o); } catch {}
      try { (nv.coronal as any).setDrawOpacity?.(o); } catch {}
      try { (nv.render3D as any).setDrawOpacity?.(o); } catch {}
      forceResizeAndDraw();
    },
    [forceResizeAndDraw]
  );

  // ---------------- edit tools ----------------
  const applyEdit = useCallback((mode: EditMode, brushSize: number, label: number) => {
    const nv = nvRef.current;
    if (!nv) return;

    const viewers: any[] = [nv.axial, nv.sagittal, nv.coronal, nv.render3D];
    viewers.forEach((v) => {
      const enabled = mode !== "off";
      try { v.setDrawingEnabled?.(enabled); } catch { v.drawingEnabled = enabled; }
      try { v.setPenSize?.(brushSize); } catch { v.penSize = brushSize; }

      const penValue = mode === "erase" ? 0 : Math.max(1, Math.floor(label || 1));
      try { v.setPenValue?.(penValue); } catch { v.penValue = penValue; }
    });
  }, []);

  const undo = useCallback(() => {
    const nv = nvRef.current;
    if (!nv) return;
    const v: any = nv.axial as any;

    try {
      if (typeof v.drawUndo === "function") v.drawUndo();
      else if (typeof v.undo === "function") v.undo();
    } catch {}

    forceResizeAndDraw();
  }, [forceResizeAndDraw]);

  // ---------------- cache control ----------------
  const clearMaskCache = useCallback(() => {
    maskBytesCacheRef.current.clear();
  }, []);

  /**
   * Best-effort export; never crash SAVE button.
   * (This stays as you wrote it. If your Niivue cannot export, backend-save is required.)
   */
  const exportEditedMaskB64 = useCallback(async (): Promise<string> => {
    const nv = nvRef.current;
    if (!nv) throw new Error("Viewer not ready");

    const v: any = nv.axial as any;

    try {
      if (typeof v.saveDrawing === "function") {
        const bytes: Uint8Array = await v.saveDrawing();
        // chunk-safe base64
        const CHUNK = 0x8000;
        let s = "";
        for (let i = 0; i < bytes.length; i += CHUNK) {
          s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
        }
        return btoa(s);
      }
    } catch {}

    throw new Error(
      "This Niivue build does not support exporting the edited drawing as NIfTI. " +
      "Implement backend save (upload edits) or use a Niivue build exposing saveDrawing()."
    );
  }, []);

  return {
    refs,
    viewerOk,
    attachReady,

    loadBaseFromB64,

    loadMask,
    unloadMask,
    setMaskOpacity,

    applyEdit,
    undo,

    clearMaskCache,
    exportEditedMaskB64,
  };
}