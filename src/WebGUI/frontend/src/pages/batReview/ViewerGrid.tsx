// Multi-pane Niivue viewport, modelled on the bfit canvas grid.
//
// Four Niivue instances (axial / coronal / sagittal / 3D) are attached once by
// useNiivue4Up and merely arranged here — the layout switch is pure CSS grid, so
// changing it never reloads a volume or drops the crosshair position. Crosshair
// synchronisation is Niivue's own broadcastTo, wired in the hook.

import { useCallback, useEffect, useRef, useState } from "react";
import { Box, IconButton, Slider, Tooltip, Typography } from "@mui/material";
import FullscreenIcon from "@mui/icons-material/Fullscreen";
import FullscreenExitIcon from "@mui/icons-material/FullscreenExit";
import PhotoCameraIcon from "@mui/icons-material/PhotoCamera";

import { VIEWS } from "./useNiivue4Up";
import type { ViewKey } from "./useNiivue4Up";
import { C } from "./theme";

export type LayoutMode = "single" | "main3" | "quad" | "row3";

export const LAYOUTS: ReadonlyArray<{
  mode: LayoutMode;
  label: string;
  hint: string;
  panes: number;
}> = [
  { mode: "single", label: "1", hint: "Single pane", panes: 1 },
  { mode: "main3", label: "1+3", hint: "One large pane with three beside it", panes: 4 },
  { mode: "row3", label: "3", hint: "Three planes across", panes: 3 },
  { mode: "quad", label: "2×2", hint: "Four equal panes", panes: 4 },
];

type Refs = Record<`${ViewKey}Ref`, React.MutableRefObject<HTMLCanvasElement | null>>;

type Props = {
  refs: Refs;
  getViewers: () => any[];
  forceResizeAndDraw: () => void;
  syncFrom: (nv: any) => void;
  layout: LayoutMode;
  viewerOk: boolean;
  ready: boolean;
  /** pane index shown alone in "single" layout, and highlighted otherwise */
  activePane: number;
  onActivePaneChange: (index: number) => void;
};

const clampSlice = (n: number, max: number) =>
  Math.min(Math.max(Math.round(n), 1), Math.max(max, 1));

/** Crosshair position (0..1 per axis) -> 1-based slice number. */
function sceneSlice(nv: any, axis: number, max: number): number {
  const pos = nv?.scene?.crosshairPos?.[axis];
  if (typeof pos !== "number" || !max) return 1;
  return clampSlice(pos * max + 1, max);
}

/** Slice count along `axis`; dimsRAS is [_, nx, ny, nz], so axis+1 indexes it. */
function sliceCount(nv: any, axis: number): number {
  const dims = nv?.volumes?.[0]?.dimsRAS;
  const n = Array.isArray(dims) ? dims[axis + 1] : 0;
  return Number.isFinite(n) ? n : 0;
}

/** Grid template per layout. Areas are p0..p3 in VIEWS order. */
function gridFor(layout: LayoutMode) {
  switch (layout) {
    case "main3":
      return {
        gridTemplateColumns: "minmax(0, 2.1fr) minmax(0, 1fr)",
        gridTemplateRows: "repeat(3, minmax(0, 1fr))",
        gridTemplateAreas: `"p0 p1" "p0 p2" "p0 p3"`,
      };
    case "row3":
      return {
        gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
        gridTemplateRows: "minmax(0, 1fr)",
        gridTemplateAreas: `"p0 p1 p2"`,
      };
    case "quad":
    default:
      return {
        gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
        gridTemplateRows: "repeat(2, minmax(0, 1fr))",
        gridTemplateAreas: `"p0 p1" "p2 p3"`,
      };
  }
}

export default function ViewerGrid({
  refs,
  getViewers,
  forceResizeAndDraw,
  syncFrom,
  layout,
  viewerOk,
  ready,
  activePane,
  onActivePaneChange,
}: Props) {
  const [slice, setSlice] = useState<number[]>([1, 1, 1, 1]);
  const [maxSlice, setMaxSlice] = useState<number[]>([0, 0, 0, 0]);
  const [expanded, setExpanded] = useState<number | null>(null);

  // Which panes this layout shows. "single" shows the active pane alone;
  // "row3" drops the 3D render, which is always last in VIEWS.
  const visible =
    expanded !== null
      ? [expanded]
      : layout === "single"
        ? [activePane]
        : layout === "row3"
          ? [0, 1, 2]
          : [0, 1, 2, 3];

  // Poll the crosshair rather than relying on onLocationChange: with
  // broadcastTo the receiving instances move without firing their own callback,
  // so a callback-only readout shows a stale slice number on three of four panes.
  const readyRef = useRef(ready);
  readyRef.current = ready;
  useEffect(() => {
    if (!ready) return;
    const tick = () => {
      const viewers = getViewers();
      if (!viewers.length) return;
      const nextMax: number[] = [];
      const nextSlice: number[] = [];
      VIEWS.forEach((v, i) => {
        if (v.axis === null) {
          nextMax[i] = 0;
          nextSlice[i] = 0;
          return;
        }
        const max = sliceCount(viewers[i], v.axis);
        nextMax[i] = max;
        nextSlice[i] = sceneSlice(viewers[i], v.axis, max);
      });
      setMaxSlice((prev) =>
        prev.length === 4 && prev.every((n, i) => n === nextMax[i]) ? prev : nextMax
      );
      setSlice((prev) =>
        prev.length === 4 && prev.every((n, i) => n === nextSlice[i]) ? prev : nextSlice
      );
    };
    tick();
    const id = window.setInterval(tick, 60);
    return () => window.clearInterval(id);
  }, [ready, getViewers]);

  // A CSS grid change resizes the canvases; Niivue needs telling.
  useEffect(() => {
    const id = window.setTimeout(forceResizeAndDraw, 0);
    return () => window.clearTimeout(id);
  }, [layout, expanded, activePane, forceResizeAndDraw]);

  const handleSlice = useCallback(
    (paneIdx: number, value: number) => {
      const view = VIEWS[paneIdx];
      if (view.axis === null) return;
      const nv = getViewers()[paneIdx];
      if (!nv) return;
      const current = sceneSlice(nv, view.axis, maxSlice[paneIdx]);
      const delta = value - current;
      if (!delta) return;
      // moveCrosshairInVox takes (x, y, z) voxel steps; only this pane's axis moves.
      const step: [number, number, number] = [0, 0, 0];
      step[view.axis] = delta;
      try {
        nv.moveCrosshairInVox(...step);
        // moveCrosshairInVox does not sync either, so drive it explicitly or
        // the slider moves this pane alone.
        syncFrom(nv);
      } catch (e) {
        console.warn("[NV] moveCrosshairInVox failed", e);
      }
      setSlice((prev) => {
        const next = [...prev];
        next[paneIdx] = value;
        return next;
      });
    },
    [getViewers, maxSlice, syncFrom]
  );

  const handleCapture = useCallback(
    (event: React.MouseEvent, paneIdx: number) => {
      event.stopPropagation();
      const nv = getViewers()[paneIdx];
      const canvas: HTMLCanvasElement | undefined = nv?.gl?.canvas;
      if (!nv || !canvas) return;
      try {
        nv.drawScene?.();
        const view = VIEWS[paneIdx];
        const stamp =
          view.axis === null ? view.short : `${view.short}-${slice[paneIdx]}`;
        const a = document.createElement("a");
        a.href = canvas.toDataURL("image/png");
        a.download = `bat-${stamp}.png`;
        a.click();
      } catch (e) {
        console.error("[NV] capture failed", e);
      }
    },
    [getViewers, slice]
  );

  return (
    <Box
      sx={{
        flex: 1,
        minWidth: 0,
        minHeight: 0,
        display: "grid",
        gap: 1,
        ...(visible.length === 1
          ? {
              gridTemplateColumns: "minmax(0, 1fr)",
              gridTemplateRows: "minmax(0, 1fr)",
              gridTemplateAreas: `"p${visible[0]}"`,
            }
          : gridFor(layout)),
      }}
    >
      {VIEWS.map((view, i) => {
        const shown = visible.includes(i);
        const canvasRef = refs[`${view.key}Ref` as keyof Refs];
        const is3D = view.axis === null;
        const max = maxSlice[i] || 0;

        return (
          <Box
            key={view.key}
            sx={{
              // Panes are never unmounted — tearing down a canvas would drop its
              // WebGL context and force a full reattach — only hidden.
              gridArea: `p${i}`,
              display: shown ? "block" : "none",
              position: "relative",
              minWidth: 0,
              minHeight: 0,
              bgcolor: C.canvas,
              border: "1px solid",
              borderColor: activePane === i ? C.accent : C.border,
              borderRadius: 2,
              overflow: "hidden",
              transition: "border-color 120ms ease",
            }}
            onMouseDown={() => onActivePaneChange(i)}
            onDoubleClick={() => setExpanded((e) => (e === i ? null : i))}
          >
            <canvas
              ref={canvasRef}
              style={{ width: "100%", height: "100%", display: "block" }}
            />

            {/* view label */}
            <Typography
              sx={{
                position: "absolute",
                top: 6,
                left: 10,
                pointerEvents: "none",
                color: activePane === i ? C.accent : C.textMuted,
                fontSize: 11,
                fontWeight: 800,
                letterSpacing: 0.8,
              }}
            >
              {view.label.toUpperCase()}
            </Typography>

            {/* slice readout */}
            {!is3D && max > 0 && (
              <Typography
                sx={{
                  position: "absolute",
                  top: 6,
                  left: 62,
                  pointerEvents: "none",
                  color: C.textFaint,
                  fontSize: 11,
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                {`I: ${slice[i]} (${slice[i]}/${max})`}
              </Typography>
            )}

            {/* per-pane actions */}
            <Box sx={{ position: "absolute", top: 2, right: 4, display: "flex", gap: 0.25 }}>
              <Tooltip title="Save this pane as PNG">
                <IconButton
                  size="small"
                  onClick={(e) => handleCapture(e, i)}
                  onDoubleClick={(e) => e.stopPropagation()}
                  sx={{ color: C.textFaint, "&:hover": { color: C.text } }}
                >
                  <PhotoCameraIcon sx={{ fontSize: 15 }} />
                </IconButton>
              </Tooltip>
              <Tooltip title={expanded === i ? "Restore layout" : "Expand (or double-click)"}>
                <IconButton
                  size="small"
                  onClick={(e) => {
                    e.stopPropagation();
                    setExpanded((v) => (v === i ? null : i));
                  }}
                  onDoubleClick={(e) => e.stopPropagation()}
                  sx={{ color: C.textFaint, "&:hover": { color: C.text } }}
                >
                  {expanded === i ? (
                    <FullscreenExitIcon sx={{ fontSize: 16 }} />
                  ) : (
                    <FullscreenIcon sx={{ fontSize: 16 }} />
                  )}
                </IconButton>
              </Tooltip>
            </Box>

            {/* slice slider */}
            {!is3D && max > 1 && (
              <Box
                sx={{
                  position: "absolute",
                  top: 30,
                  bottom: 10,
                  right: 6,
                  display: "flex",
                  alignItems: "center",
                }}
                onDoubleClick={(e) => e.stopPropagation()}
              >
                <Slider
                  orientation="vertical"
                  size="small"
                  value={slice[i] || 1}
                  min={1}
                  max={max}
                  onChange={(_, v) => handleSlice(i, v as number)}
                  sx={{
                    height: "100%",
                    color: C.accent,
                    "& .MuiSlider-rail": { width: 3, color: C.borderStrong, opacity: 1 },
                    "& .MuiSlider-track": { width: 3, border: "none" },
                    "& .MuiSlider-thumb": {
                      width: 11,
                      height: 11,
                      "&:hover, &.Mui-focusVisible": {
                        boxShadow: `0 0 0 6px rgba(124,156,245,0.16)`,
                      },
                    },
                  }}
                />
              </Box>
            )}

            {(!viewerOk || !ready) && (
              <Box
                sx={{
                  position: "absolute",
                  inset: 0,
                  display: "grid",
                  placeItems: "center",
                  pointerEvents: "none",
                }}
              >
                <Typography sx={{ color: C.textFaint, fontSize: 12 }}>
                  {viewerOk ? "Initialising…" : "WebGL not available"}
                </Typography>
              </Box>
            )}
          </Box>
        );
      })}
    </Box>
  );
}
