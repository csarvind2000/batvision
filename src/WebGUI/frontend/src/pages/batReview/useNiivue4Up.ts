// src/pages/BatReview/useNiivue4Up.ts
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Niivue, NVImage, NVUtilities } from "@niivue/niivue";
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

export type ViewKey = "axial" | "coronal" | "sagittal" | "render3D";

/**
 * Pane order used everywhere: pane 0 is the "main" one in the 1+3 layout, and
 * the 3D render is always last so a 3-across layout can simply drop it.
 *
 * `axis` is the index into a voxel/crosshair triple that this view slices
 * along, which is what turns a crosshair position into a slice number.
 */
export const VIEWS: ReadonlyArray<{
  key: ViewKey;
  label: string;
  short: string;
  axis: 0 | 1 | 2 | null;   // null => 3D render, it has no slice index
}> = [
  { key: "axial", label: "Axial", short: "AX", axis: 2 },
  { key: "coronal", label: "Coronal", short: "COR", axis: 1 },
  { key: "sagittal", label: "Sagittal", short: "SAG", axis: 0 },
  { key: "render3D", label: "3D", short: "3D", axis: null },
];

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

  // Kept in sync with CLASS_COLORS in theme.ts, which labels the same classes in
  // the side panel. Saturated RGB primaries (255,0,0 / 0,255,0 / 0,0,255) read
  // as fringing over a greyscale MRI and make thin BAT boundaries harder to
  // judge; these are the same hues pulled off full saturation.
  if (mask === "binary") {
    set(1, 255, 59, 48, 255);
  } else if (mask === "c3") {
    set(1, 255, 59, 48, 255);
    set(2, 52, 199, 89, 255);
    set(3, 10, 132, 255, 255);
  } else {
    set(1, 255, 59, 48, 255);
    set(2, 52, 199, 89, 255);
    set(3, 10, 132, 255, 255);
    set(4, 255, 214, 10, 255);
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
 * Point the drawing colormap at `lut` (RGBA x 256) and get it onto the GPU.
 *
 * The upload is the part that is easy to miss: Niivue only copies
 * `drawLut.lut` into the colormap texture inside refreshColormaps(). Setting
 * the LUT and then calling refreshDrawing()/drawScene() -- which is what this
 * did before -- re-uploads the drawing *bitmap* but not the *colours*, so the
 * new LUT never took effect and the canvas kept rendering with whichever LUT
 * happened to be uploaded last. That is why a 4-class mask could come up drawn
 * entirely in the binary mask's red: same bitmap, stale palette.
 */
function applyDrawLutSafe(nv: any, lut?: Uint8Array) {
  if (!lut) return;
  try {
    if (!nv.drawLut || typeof nv.drawLut !== "object") {
      nv.drawLut = { lut, labels: new Array(256).fill("") };
    } else {
      nv.drawLut.lut = lut;
      if (!Array.isArray(nv.drawLut.labels) || nv.drawLut.labels.length < 256) {
        nv.drawLut.labels = new Array(256).fill("");
      }
    }

    // the line that actually makes the palette visible
    nv.refreshColormaps?.();
    nv.refreshDrawing?.(false);
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
  // loadDrawingFromUrl catches its own errors and reports failure by RETURNING
  // FALSE rather than throwing. Treating the call as successful just because it
  // did not throw is how a mask silently fails to load and the previous overlay
  // stays on screen -- so the boolean has to be checked, not discarded.
  if (typeof v.loadDrawingFromUrl !== "function") {
    throw new Error("No supported drawing loader on this Niivue build.");
  }

  try {
    if ((await v.loadDrawingFromUrl(bytes)) === true) return;
  } catch {
    // fall through to the object-URL form below
  }

  const blob = new Blob([bytes.slice().buffer], { type: "application/gzip" });
  const url = URL.createObjectURL(blob);
  try {
    if ((await v.loadDrawingFromUrl({ url, name })) === true) return;
    if (typeof v.loadDrawing === "function" && (await v.loadDrawing({ url, name })) === true) {
      return;
    }
    throw new Error(
      `Niivue could not load the mask "${name}". It usually means the mask grid ` +
        "does not match the base image."
    );
  } finally {
    URL.revokeObjectURL(url);
  }
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
          // 0.67 has no `isCrosshair`; the 2D crosshair is drawn whenever it has
          // a width, and passing an unknown key here is silently ignored.
          crosshairWidth: 1,
          // leave the centre clear: a solid cross hides the voxel it points at,
          // which is exactly the one a reviewer is looking at
          crosshairGap: 12,
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

  // ---------------- crosshair / camera sync ----------------
  // Niivue drives this itself: broadcastTo mirrors 2D crosshair + pan and the
  // 3D camera from one instance to the others, and it fires on every source of
  // change (click, drag, wheel, keyboard) rather than only the ones a callback
  // happens to cover. An earlier version of this hook monkey-patched
  // setSliceMM/setCrosshairPos and re-broadcast through a RAF throttle; that
  // missed wheel-scroll on builds that do not route it through those setters,
  // which is why the views drifted apart.
  useEffect(() => {
    if (!attachReady) return;
    const nv = nvRef.current;
    if (!nv) return;

    const viewers = [nv.axial, nv.sagittal, nv.coronal, nv.render3D];
    viewers.forEach((v) => {
      const others = viewers.filter((o) => o !== v);
      try {
        v.broadcastTo(others, { "2d": true, "3d": true });
      } catch (e) {
        console.warn("[NV] broadcastTo unavailable on this build", e);
      }
    });

    // broadcastTo is not enough on its own for the mouse wheel. Niivue calls
    // sync() from wheelListener only on the zoom branch; the ordinary
    // slice-scroll path ends at sliceScroll2D(), which never syncs. So a wheel
    // scroll moved one pane and left the other three behind. Pushing sync()
    // ourselves after the canvas has handled the event fixes it without
    // touching Niivue internals -- our listener is registered after Niivue's,
    // so it runs once the new slice is already in place.
    const cleanups = viewers.map((v) => {
      // gl.canvas is typed as HTMLCanvasElement | OffscreenCanvas; only the
      // former has addEventListener, and it is always the former here.
      const canvas = v?.gl?.canvas;
      if (!canvas || !(canvas instanceof HTMLCanvasElement)) return () => {};
      let queued = false;
      const onWheel = () => {
        if (queued) return;
        queued = true;
        requestAnimationFrame(() => {
          queued = false;
          try {
            v.sync();
          } catch (e) {
            console.warn("[NV] sync after wheel failed", e);
          }
        });
      };
      canvas.addEventListener("wheel", onWheel, { passive: true });
      return () => canvas.removeEventListener("wheel", onWheel);
    });

    return () => cleanups.forEach((c) => c());
  }, [attachReady]);

  /** Push one viewer's crosshair to the other three (see the wheel note above). */
  const syncFrom = useCallback((v: any) => {
    try {
      v?.sync?.();
    } catch (e) {
      console.warn("[NV] sync failed", e);
    }
  }, []);

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

      // loadVolumes is typed for ImageFromUrlOptions, but accepts an already
      // constructed NVImage at runtime — which is what we want, so the four
      // viewers share one decode of the volume instead of fetching it 4x.
      const volumes = [base] as unknown as Parameters<Niivue["loadVolumes"]>[0];
      await nv.axial.loadVolumes(volumes);
      await nv.sagittal.loadVolumes(volumes);
      await nv.coronal.loadVolumes(volumes);
      await nv.render3D.loadVolumes(volumes);

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
  const applyEdit = useCallback(
    (mode: EditMode, brushSize: number, label: number, filled: boolean = true) => {
      const nv = nvRef.current;
      if (!nv) return;

      const viewers: any[] = [nv.axial, nv.sagittal, nv.coronal, nv.render3D];
      const enabled = mode !== "off";

      viewers.forEach((v) => {
        try { v.setDrawingEnabled?.(enabled); } catch { v.drawingEnabled = enabled; }
        try { v.setPenSize?.(brushSize); } catch { v.penSize = brushSize; }

        // setPenValue's second argument is isFilledPen: closing a loop in one
        // drag flood-fills its interior, so outlining a depot paints it solid
        // instead of leaving a ring the user has to scribble in.
        const penValue = mode === "erase" ? 0 : Math.max(1, Math.floor(label || 1));
        try {
          v.setPenValue?.(penValue, enabled && filled);
        } catch {
          v.penValue = penValue;
          if (v.opts) v.opts.isFilledPen = enabled && filled;
        }

        // The crosshair sits exactly where the pen is, so it hides whatever is
        // being drawn. Take it away while a tool is active and restore it after.
        try {
          if (v.opts) v.opts.crosshairWidth = enabled ? 0 : 1;
          v.drawScene?.();
        } catch {}
      });
    },
    []
  );

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
   * Export the edited drawing as gzipped NIfTI, base64-encoded.
   *
   * Niivue 0.67 exports a drawing through saveImage({ isSaveDrawing: true }),
   * which returns the bytes when the filename is empty and triggers a browser
   * download when it is not. An earlier version called saveDrawing(), which
   * does not exist on this build, so every save threw.
   */
  const exportEditedMaskB64 = useCallback(async (): Promise<string> => {
    const nv = nvRef.current;
    if (!nv) throw new Error("Viewer not ready");

    const v = nv.axial as any;
    if (typeof v.saveImage !== "function") {
      throw new Error(
        "This Niivue build exposes no drawing export (saveImage). Upgrade @niivue/niivue."
      );
    }

    // An empty filename returns the bytes instead of triggering a browser
    // download -- but Niivue decides compression from that same filename
    // (`compress = fnm.endsWith(".gz")`), so what comes back is an
    // *uncompressed* NIfTI. Left as-is that is ~2.7 MB for a 160x160x104
    // volume, which overflows Django's 2.5 MB request cap, and it would be
    // written to a .nii.gz path that is not actually gzipped.
    const raw = await v.saveImage({
      filename: "",
      isSaveDrawing: true,
      volumeByIndex: 0,
    });

    if (!(raw instanceof Uint8Array) || raw.length === 0) {
      throw new Error(
        "Niivue returned no drawing bytes — is a mask loaded and edited?"
      );
    }

    // Gzip it ourselves, with Niivue's own helper, so the payload really is a
    // .nii.gz. A BAT mask is almost entirely zeros, so this is a ~500x
    // reduction, not a marginal one.
    let result: Uint8Array;
    try {
      result = new Uint8Array(await NVUtilities.compress(raw, "gzip"));
    } catch (e) {
      console.warn("[NV] gzip of drawing failed, sending uncompressed", e);
      result = raw;
    }

    // chunked, because String.fromCharCode(...bytes) overflows the call stack
    // on a volume-sized array
    const CHUNK = 0x8000;
    let binary = "";
    for (let i = 0; i < result.length; i += CHUNK) {
      binary += String.fromCharCode(...result.subarray(i, i + CHUNK));
    }
    return btoa(binary);
  }, []);

  /** The four Niivue instances in VIEWS order, or [] before attach. */
  const getViewers = useCallback((): Niivue[] => {
    const nv = nvRef.current;
    if (!nv) return [];
    return VIEWS.map((v) => nv[v.key]);
  }, []);

  return {
    refs,
    getViewers,
    forceResizeAndDraw,
    syncFrom,
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