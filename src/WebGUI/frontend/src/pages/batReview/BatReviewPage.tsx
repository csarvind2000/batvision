// src/pages/batReview/BatReviewPage.tsx
//
// ✅ Works with Niivue drawing overlays (mask as drawing):
// - Base image: FAT or FAT FRACTION (if available)
// - Mask overlay: binary / 3-class / 4-class via loadMask({ maskB64, lut })
// - Edit palette + brush + opacity controls
// - Save calls apiSaveBatAnnotation() with edited mask b64
//
// NOTE: This file assumes your hook is the UPDATED one that exports makeBatLut
//       and loadMask expects maskB64 or maskUrl.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  Box,
  Button,
  Divider,
  IconButton,
  Paper,
  Slider,
  Stack,
  CircularProgress,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from "@mui/material";

import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import VisibilityIcon from "@mui/icons-material/Visibility";
import VisibilityOffIcon from "@mui/icons-material/VisibilityOff";
import FormatColorFillIcon from "@mui/icons-material/FormatColorFill";
import UndoIcon from "@mui/icons-material/Undo";
import DeleteSweepIcon from "@mui/icons-material/DeleteSweep";
import SaveIcon from "@mui/icons-material/Save";

import GridViewIcon from "@mui/icons-material/GridView";

import { apiBatReview, apiSaveBatAnnotation } from "../../api/client";
import { useNiivue4Up, makeBatLut, VIEWS } from "./useNiivue4Up";
import type { MaskType } from "./useNiivue4Up";
import ViewerGrid, { LAYOUTS } from "./ViewerGrid";
import type { LayoutMode } from "./ViewerGrid";
import { C, BORDER as T_BORDER, toggleSx as themeToggleSx, panelSx, CLASS_COLORS } from "./theme";

type ReviewPayload = {
  case?: {
    patientName?: string;
    patientId?: string;
    seriesType?: string;
    status?: string;
  };
  nifti?: {
    image_b64?: string; // FAT
    image_name?: string;

    ff_b64?: string; // FAT FRACTION
    ff_name?: string;

    binary_b64?: string;
    class3_b64?: string;
    class4_b64?: string;

    binary_name?: string;
    class3_name?: string;
    class4_name?: string;

    // OPTIONAL if you add later (recommended):
    // binary_url?: string;
    // class3_url?: string;
    // class4_url?: string;
  };
  volumes?: {
    binary_total_ml?: number;
    class3_total_ml?: number;
    class4_total_ml?: number;

    class3_breakdown_ml?: {
      class1_muscle_ml?: number;
      class2_brownfat_ml?: number;
      class3_mixwhite_ml?: number;
    };

    class4_breakdown_ml?: {
      class1_muscle_ml?: number;
      class2_brownfat_ml?: number;
      class3_mixfat_ml?: number;
      class4_whitefat_ml?: number;
    };
  };
};

const toggleSx = themeToggleSx;

type BaseImage = "fat" | "ff";
type EditMode = "off" | "draw" | "erase";

function toNum(v: any): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const x = parseFloat(v);
    return Number.isFinite(x) ? x : null;
  }
  return null;
}

const BORDER = T_BORDER;

const MASK_BADGE: Record<MaskType, { tag: string; color: string }> = {
  binary: { tag: "BAT", color: CLASS_COLORS[1] },
  c3: { tag: "C3", color: CLASS_COLORS[2] },
  c4: { tag: "C4", color: CLASS_COLORS[4] },
};

const CLASS_CHIPS = [
  { label: "Class 1", color: CLASS_COLORS[1], value: 1 },
  { label: "Class 2", color: CLASS_COLORS[2], value: 2 },
  { label: "Class 3", color: CLASS_COLORS[3], value: 3 },
  { label: "Class 4", color: CLASS_COLORS[4], value: 4 },
];

/** Uppercase rule-and-label that separates the side-panel sections. */
function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <Typography
      sx={{
        px: 2,
        pt: 1.75,
        pb: 1,
        color: C.textFaint,
        fontSize: 10.5,
        fontWeight: 800,
        letterSpacing: 0.9,
        textTransform: "uppercase",
        borderBottom: T_BORDER,
        mb: 1.25,
      }}
    >
      {children}
    </Typography>
  );
}

export default function BatReviewPage() {
  const params = useParams();
  const navigate = useNavigate();

  const caseIdStr = (params as any).caseId || (params as any).id;
  const caseIdNum = caseIdStr ? Number(caseIdStr) : NaN;

  const [raw, setRaw] = useState<ReviewPayload | null>(null);
  const [err, setErr] = useState("");

  const [baseImg, setBaseImg] = useState<BaseImage>("fat");
  const [displayedMask, setDisplayedMask] = useState<MaskType | null>(null);
  const [maskOpacity, setMaskOpacityLocal] = useState(0.6);

  const [editMode, setEditMode] = useState<EditMode>("off");
  const [brushSize, setBrushSize] = useState(8);
  // Filled pen: closing a contour in one drag fills its interior. On by
  // default -- outlining a depot is the common action -- but switchable off for
  // single-voxel touch-ups.
  const [fillContour, setFillContour] = useState(true);
  const [activeLabel, setActiveLabel] = useState<number>(1);

  const [saving, setSaving] = useState(false);

  // viewer layout; the pane index is which view "single" shows and which one
  // the other layouts highlight
  const [layout, setLayout] = useState<LayoutMode>("main3");
  const [activePane, setActivePane] = useState(0);

  const {
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
  } = useNiivue4Up();

  const baseLoadGen = useRef(0);

  // Show a segmentation as soon as one is available: opening a review to a bare
  // greyscale image hides the very thing the page exists to show. Latched, so it
  // happens once per base load and never fights a reviewer who hides the overlay.
  const autoShowPendingRef = useRef(true);

  const getBaseInfo = useCallback((payload: ReviewPayload | null, chosen: BaseImage) => {
    const n = payload?.nifti || {};
    const hasFF = !!n.ff_b64;
    const effective: BaseImage = chosen === "ff" && !hasFF ? "fat" : chosen;

    const b64 = effective === "ff" ? n.ff_b64 : n.image_b64;
    const name =
      effective === "ff"
        ? n.ff_name || "fat_fraction.nii.gz"
        : n.image_name || "fat.nii.gz";

    return { effective, b64: b64 || "", name, hasFF };
  }, []);

  const getMaskInfo = useCallback((payload: ReviewPayload | null, mask: MaskType) => {
    const n = payload?.nifti || {};

    if (mask === "binary") {
      return { b64: n.binary_b64 || "", name: n.binary_name || "pred_binary.nii.gz" };
    }
    if (mask === "c3") {
      return { b64: n.class3_b64 || "", name: n.class3_name || "mask_3class.nii.gz" };
    }
    return { b64: n.class4_b64 || "", name: n.class4_name || "mask_4class.nii.gz" };
  }, []);

  // Fetch payload
  useEffect(() => {
    if (!caseIdStr || Number.isNaN(caseIdNum)) {
      setErr("Invalid case id in URL.");
      setRaw(null);
      return;
    }

    let cancelled = false;

    (async () => {
      try {
        setErr("");
        setRaw(null);
        clearMaskCache();

        const payload = (await apiBatReview(caseIdNum)) as ReviewPayload;
        if (cancelled) return;

        console.log("[BAT] review payload keys", {
          hasFat: !!payload?.nifti?.image_b64,
          hasFF: !!payload?.nifti?.ff_b64,
          hasBinary: !!payload?.nifti?.binary_b64,
          hasC3: !!payload?.nifti?.class3_b64,
          hasC4: !!payload?.nifti?.class4_b64,
        });

        setRaw(payload);
      } catch (e: any) {
        if (cancelled) return;
        setErr(e?.message || "Failed to load BAT review");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [caseIdStr, caseIdNum, clearMaskCache]);

  // Load base when ready
  useEffect(() => {
    if (!raw) return;
    if (!viewerOk || !attachReady) return;

    const gen = ++baseLoadGen.current;

    (async () => {
      try {
        setErr("");

        const { b64, name, effective } = getBaseInfo(raw, baseImg);
        console.log("[BAT] load base requested", {
          chosen: baseImg,
          effective,
          name,
          b64Len: b64?.length || 0,
        });

        if (!b64) {
          setErr("Base image missing in payload (image_b64 / ff_b64).");
          return;
        }

        await loadBaseFromB64({ b64, name });

        if (baseLoadGen.current === gen) {
          // base changed => reset mask + tools. The drawing is tied to the
          // volume it was loaded against, so it has to be re-loaded rather
          // than left in place.
          unloadMask();
          setDisplayedMask(null);
          setEditMode("off");
          setActiveLabel(1);
          // re-arm the default overlay so switching Fat <-> Fat fraction does
          // not silently leave the reviewer with no segmentation on screen
          autoShowPendingRef.current = true;
        }
      } catch (e: any) {
        setErr(e?.message || "Failed to load base image");
      }
    })();
  }, [raw, baseImg, viewerOk, attachReady, getBaseInfo, loadBaseFromB64, unloadMask]);

  // Live opacity update
  useEffect(() => {
    if (!displayedMask) return;
    setMaskOpacity(maskOpacity);
  }, [displayedMask, maskOpacity, setMaskOpacity]);

  // Apply edit settings whenever they change
  useEffect(() => {
    if (!displayedMask) {
      applyEdit("off", brushSize, 1, fillContour);
      return;
    }

    const effectiveLabel = displayedMask === "binary" ? 1 : Math.max(1, Math.min(4, activeLabel));
    applyEdit(editMode, brushSize, effectiveLabel, fillContour);
  }, [displayedMask, editMode, brushSize, activeLabel, fillContour, applyEdit]);

  // ✅ Single reliable toggle function (prevents double triggers)
  const toggleMask = useCallback(
    async (mask: MaskType) => {
      if (!raw) return;
      if (!viewerOk || !attachReady) return;

      const isCurrentlyOn = displayedMask === mask;

      // Turn OFF
      if (isCurrentlyOn) {
        unloadMask();
        setDisplayedMask(null);
        setEditMode("off");
        setActiveLabel(1);
        return;
      }

      // Switching to another mask
      try {
        setErr("");

        // clear old overlay first
        if (displayedMask) {
          unloadMask();
          setDisplayedMask(null);
          setEditMode("off");
        }

        const { b64, name } = getMaskInfo(raw, mask);
        console.log("[BAT] toggle mask", { mask, name, b64Len: b64?.length || 0 });

        if (!b64) {
          setErr(`Mask missing for ${mask}`);
          unloadMask();
          setDisplayedMask(null);
          setEditMode("off");
          return;
        }

        const key = `${caseIdNum}:${mask}`;
        const lut = makeBatLut(mask);

        // ✅ FIX: hook expects maskB64 or maskUrl
        await loadMask({
          key,
          opacity: maskOpacity,
          lut,
          maskB64: b64,
          name,
        });

        setDisplayedMask(mask);
        setEditMode("off");
        setActiveLabel(1);
      } catch (e: any) {
        console.error(e);
        setErr(e?.message || `Failed to load mask ${mask}`);
        unloadMask();
        setDisplayedMask(null);
        setEditMode("off");
      }
    },
    [
      raw,
      viewerOk,
      attachReady,
      displayedMask,
      getMaskInfo,
      loadMask,
      unloadMask,
      caseIdNum,
      maskOpacity,
    ]
  );

  // Auto-show the first available segmentation once the viewer and payload are
  // both ready. Binary is the primary read-out; the class maps are the fallback
  // if a case somehow lacks it.
  useEffect(() => {
    if (!autoShowPendingRef.current) return;
    if (!raw || !viewerOk || !attachReady) return;
    if (displayedMask) return;

    const preferred: MaskType[] = ["binary", "c4", "c3"];
    const first = preferred.find((m) => !!getMaskInfo(raw, m).b64);
    if (!first) return;

    autoShowPendingRef.current = false;
    void toggleMask(first);
  }, [raw, viewerOk, attachReady, displayedMask, getMaskInfo, toggleMask]);

  const doClearDrawing = useCallback(() => {
    try {
      unloadMask();
      setDisplayedMask(null);
      setEditMode("off");
      setActiveLabel(1);
    } catch {}
  }, [unloadMask]);

  const doSave = useCallback(async () => {
    if (!displayedMask) return;
    if (Number.isNaN(caseIdNum)) return;

    try {
      setSaving(true);
      setErr("");

      const edited_b64 = await exportEditedMaskB64();

      const filename =
        displayedMask === "binary"
          ? "pred_binary_edited.nii.gz"
          : displayedMask === "c3"
            ? "mask_3class_edited.nii.gz"
            : "mask_4class_edited.nii.gz";

      // The endpoint returns the same shape as GET /bat-review/, already
      // recomputed from the mask just saved. Dropping it on the floor was why
      // the volumes never changed after a save.
      const refreshed = (await apiSaveBatAnnotation(caseIdNum, {
        mask_type: displayedMask,
        filename,
        edited_mask_b64: edited_b64,
      })) as ReviewPayload | undefined;

      // The cached bytes are the pre-edit mask; keep them and the next toggle
      // would quietly reload the old overlay over the new numbers.
      clearMaskCache();

      if (refreshed?.nifti) {
        setRaw(refreshed);
        const { b64, name } = getMaskInfo(refreshed, displayedMask);
        if (b64) {
          await loadMask({
            key: `${caseIdNum}:${displayedMask}:${Date.now()}`,
            opacity: maskOpacity,
            lut: makeBatLut(displayedMask),
            maskB64: b64,
            name,
          });
        }
      }
    } catch (e: any) {
      console.error(e);
      setErr(e?.message || "Save failed");
    } finally {
      setSaving(false);
    }
  }, [
    displayedMask,
    caseIdNum,
    exportEditedMaskB64,
    clearMaskCache,
    getMaskInfo,
    loadMask,
    maskOpacity,
  ]);

  const info = raw?.case || {};
  const vols = raw?.volumes || {};
  const { hasFF } = getBaseInfo(raw, baseImg);

  const binaryTotal = toNum(vols.binary_total_ml);
  const c3Total = toNum(vols.class3_total_ml);
  const c4Total = toNum(vols.class4_total_ml);

  const c3b = vols.class3_breakdown_ml || {};
  const c4b = vols.class4_breakdown_ml || {};

  const segs = useMemo(
    () =>
      [
        { key: "binary" as MaskType, label: "Binary", sub: "BAT" },
        { key: "c4" as MaskType, label: "4 Class", sub: "BAT" },
        { key: "c3" as MaskType, label: "3 Class", sub: "BAT" },
      ] as const,
    []
  );

  // Only a load failure blocks the page. Errors raised later (a mask that will
  // not load, a failed save) surface in the side panel instead, so one bad
  // overlay never throws away a review already in progress.
  if (err && !raw) {
    return (
      <Box sx={{ height: "100vh", bgcolor: C.bg, p: 2 }}>
        <Button
          startIcon={<ArrowBackIcon />}
          onClick={() => navigate("/cases")}
          sx={{ color: C.textMuted, textTransform: "none" }}
        >
          Back to cases
        </Button>
        <Paper sx={{ ...panelSx, p: 2.5, mt: 2, maxWidth: 620, borderColor: C.danger }}>
          <Typography sx={{ color: C.danger, fontWeight: 700, fontSize: 14, mb: 0.5 }}>
            Could not open this review
          </Typography>
          <Typography sx={{ color: C.textMuted, fontSize: 13, whiteSpace: "pre-wrap" }}>
            {err}
          </Typography>
        </Paper>
      </Box>
    );
  }

  if (!raw) {
    return (
      <Box sx={{ height: "100vh", bgcolor: C.bg, display: "grid", placeItems: "center" }}>
        <Stack spacing={1.5} alignItems="center">
          <CircularProgress size={26} sx={{ color: C.accent }} />
          <Typography sx={{ color: C.textMuted, fontSize: 13 }}>Loading review…</Typography>
        </Stack>
      </Box>
    );
  }

  // Volumes exist as soon as the case is analysed, so the panel shows them
  // whether or not an overlay happens to be switched on. Tying the numbers to
  // the overlay toggle made the panel read as empty most of the time.
  const totals: { key: MaskType; label: string; value: number | null }[] = [
    { key: "binary", label: "Binary BAT", value: binaryTotal },
    { key: "c3", label: "3-class total", value: c3Total },
    { key: "c4", label: "4-class total", value: c4Total },
  ];

  const breakdown: { color: string; name: string; value: number | null }[] =
    displayedMask === "c3"
      ? [
          { color: CLASS_COLORS[1], name: "Muscle", value: toNum(c3b.class1_muscle_ml) },
          { color: CLASS_COLORS[2], name: "Brown fat", value: toNum(c3b.class2_brownfat_ml) },
          { color: CLASS_COLORS[3], name: "Mix + white", value: toNum(c3b.class3_mixwhite_ml) },
        ]
      : displayedMask === "c4"
        ? [
            { color: CLASS_COLORS[1], name: "Muscle", value: toNum(c4b.class1_muscle_ml) },
            { color: CLASS_COLORS[2], name: "Brown fat", value: toNum(c4b.class2_brownfat_ml) },
            { color: CLASS_COLORS[3], name: "Mixed fat", value: toNum(c4b.class3_mixfat_ml) },
            { color: CLASS_COLORS[4], name: "White fat", value: toNum(c4b.class4_whitefat_ml) },
          ]
        : [];

  const breakdownTotal = displayedMask === "c3" ? c3Total : c4Total;

  return (
    <Box
      sx={{
        height: "100vh",
        bgcolor: C.bg,
        p: 2,
        display: "flex",
        flexDirection: "column",
        gap: 1.5,
      }}
    >
      {/* ── header ─────────────────────────────────────────────────────── */}
      <Stack direction="row" spacing={1.5} alignItems="center">
        <Tooltip title="Back to cases">
          <IconButton onClick={() => navigate("/cases")} sx={{ color: C.textMuted }}>
            <ArrowBackIcon fontSize="small" />
          </IconButton>
        </Tooltip>

        <Box>
          <Typography sx={{ color: C.text, fontWeight: 800, fontSize: 17, lineHeight: 1.2 }}>
            {info.patientId ?? info.patientName ?? "—"}
          </Typography>
          <Typography sx={{ color: C.textFaint, fontSize: 11.5 }}>
            {info.seriesType ?? "BAT"} review
            {info.status ? ` · ${String(info.status).toLowerCase()}` : ""}
          </Typography>
        </Box>

        <Box sx={{ flex: 1 }} />
      </Stack>

      <Stack direction="row" spacing={1.5} sx={{ flex: 1, minHeight: 0 }}>
        {/* ── left panel ───────────────────────────────────────────────── */}
        <Paper
          sx={{
            ...panelSx,
            width: 320,
            flexShrink: 0,
            overflowY: "auto",
            display: "flex",
            flexDirection: "column",
          }}
        >
          <SectionLabel>Segmentations</SectionLabel>
          <Box sx={{ px: 1.5, pb: 1.5 }}>
            {segs.map((seg) => {
              const on = displayedMask === seg.key;
              const badge = MASK_BADGE[seg.key];
              const total = totals.find((t) => t.key === seg.key)?.value ?? null;
              return (
                <Stack
                  key={seg.key}
                  direction="row"
                  alignItems="center"
                  spacing={1}
                  sx={{
                    py: 0.75,
                    px: 1,
                    borderRadius: 1.5,
                    cursor: "pointer",
                    bgcolor: on ? "rgba(124,156,245,0.10)" : "transparent",
                    "&:hover": { bgcolor: "rgba(124,156,245,0.06)" },
                  }}
                  onClick={() => (viewerOk && attachReady ? toggleMask(seg.key) : undefined)}
                >
                  <Box
                    sx={{
                      width: 8,
                      height: 8,
                      borderRadius: "50%",
                      bgcolor: badge.color,
                      flexShrink: 0,
                    }}
                  />
                  <Typography sx={{ color: C.text, fontSize: 13, fontWeight: 600, flex: 1 }}>
                    {seg.label}
                  </Typography>
                  <Typography
                    sx={{
                      color: on ? C.text : C.textFaint,
                      fontSize: 12,
                      fontVariantNumeric: "tabular-nums",
                    }}
                  >
                    {total !== null ? `${total.toFixed(1)} mL` : "—"}
                  </Typography>
                  {/* Visibility is an eye, not a switch: it reads as "showing /
                      not showing" rather than "enabled / disabled". */}
                  <Tooltip title={on ? "Hide overlay" : "Show overlay"}>
                    <span>
                      <IconButton
                        size="small"
                        disabled={!viewerOk || !attachReady}
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleMask(seg.key);
                        }}
                        sx={{
                          color: on ? C.accent : C.textFaint,
                          "&:hover": { color: on ? C.accent : C.textMuted },
                        }}
                      >
                        {on ? (
                          <VisibilityIcon sx={{ fontSize: 18 }} />
                        ) : (
                          <VisibilityOffIcon sx={{ fontSize: 18 }} />
                        )}
                      </IconButton>
                    </span>
                  </Tooltip>
                </Stack>
              );
            })}

            {viewerOk && !attachReady && (
              <Typography sx={{ color: C.warn, fontSize: 11.5, mt: 1 }}>
                Viewer initialising…
              </Typography>
            )}
            {!viewerOk && (
              <Typography sx={{ color: C.warn, fontSize: 11.5, mt: 1 }}>
                WebGL not available in this browser.
              </Typography>
            )}
            {err && (
              <Typography sx={{ color: C.danger, fontSize: 11.5, mt: 1, whiteSpace: "pre-wrap" }}>
                {err}
              </Typography>
            )}
          </Box>

          <SectionLabel>Overlay</SectionLabel>
          <Box sx={{ px: 2, pb: 2 }}>
            <Stack direction="row" justifyContent="space-between" sx={{ mb: 0.5 }}>
              <Typography sx={{ color: C.textMuted, fontSize: 12 }}>Opacity</Typography>
              <Typography sx={{ color: C.textFaint, fontSize: 12, fontVariantNumeric: "tabular-nums" }}>
                {(maskOpacity * 100).toFixed(0)}%
              </Typography>
            </Stack>
            <Slider
              min={0}
              max={1}
              step={0.01}
              value={maskOpacity}
              onChange={(_, v) => setMaskOpacityLocal(v as number)}
              disabled={!displayedMask}
              size="small"
              sx={{ color: C.accent }}
            />
          </Box>

          <SectionLabel>Editing</SectionLabel>
          <Box sx={{ px: 2, pb: 2 }}>
            <Stack direction="row" spacing={1} alignItems="center">
              <ToggleButtonGroup
                exclusive
                size="small"
                value={editMode}
                onChange={(_, v) => setEditMode((v || "off") as EditMode)}
                disabled={!displayedMask}
              >
                <ToggleButton value="off" sx={toggleSx}>Off</ToggleButton>
                <ToggleButton value="draw" sx={toggleSx}>Draw</ToggleButton>
                <ToggleButton value="erase" sx={toggleSx}>Erase</ToggleButton>
              </ToggleButtonGroup>

              <Tooltip title="Fill closed contours as you draw">
                <span>
                  <ToggleButton
                    value="fill"
                    size="small"
                    selected={fillContour}
                    disabled={!displayedMask || editMode === "off"}
                    onChange={() => setFillContour((f) => !f)}
                    sx={{ ...toggleSx, ml: 1, px: 1 }}
                  >
                    <FormatColorFillIcon sx={{ fontSize: 16 }} />
                  </ToggleButton>
                </span>
              </Tooltip>

              <Box sx={{ flex: 1 }} />

              <Tooltip title="Undo last stroke">
                <span>
                  <IconButton
                    size="small"
                    disabled={!displayedMask}
                    onClick={undo}
                    sx={{ color: C.textMuted, "&:hover": { color: C.text } }}
                  >
                    <UndoIcon sx={{ fontSize: 17 }} />
                  </IconButton>
                </span>
              </Tooltip>
              <Tooltip title="Remove the overlay">
                <span>
                  <IconButton
                    size="small"
                    disabled={!displayedMask}
                    onClick={doClearDrawing}
                    sx={{ color: C.textMuted, "&:hover": { color: C.danger } }}
                  >
                    <DeleteSweepIcon sx={{ fontSize: 17 }} />
                  </IconButton>
                </span>
              </Tooltip>
            </Stack>

            <Stack direction="row" justifyContent="space-between" sx={{ mt: 1.5, mb: 0.5 }}>
              <Typography sx={{ color: C.textMuted, fontSize: 12 }}>Brush</Typography>
              <Typography sx={{ color: C.textFaint, fontSize: 12, fontVariantNumeric: "tabular-nums" }}>
                {brushSize} px
              </Typography>
            </Stack>
            <Slider
              min={1}
              max={40}
              step={1}
              value={brushSize}
              onChange={(_, v) => setBrushSize(v as number)}
              disabled={!displayedMask || editMode === "off"}
              size="small"
              sx={{ color: C.accent }}
            />

            {/* Label picker only exists for the multi-class masks; a binary mask
                has exactly one label, so offering four was a false choice. */}
            {displayedMask && displayedMask !== "binary" && (
              <>
                <Typography sx={{ color: C.textMuted, fontSize: 12, mt: 1, mb: 0.75 }}>
                  Paint as
                </Typography>
                <Stack direction="row" spacing={0.75}>
                  {CLASS_CHIPS.filter((c) => (displayedMask === "c3" ? c.value <= 3 : true)).map(
                    (c) => {
                      const active = activeLabel === c.value;
                      return (
                        <Box
                          key={c.value}
                          onClick={() => setActiveLabel(c.value)}
                          sx={{
                            cursor: "pointer",
                            flex: 1,
                            textAlign: "center",
                            py: 0.5,
                            borderRadius: 1,
                            border: "1px solid",
                            borderColor: active ? c.color : C.border,
                            bgcolor: active ? `${c.color}22` : "transparent",
                          }}
                        >
                          <Box
                            sx={{
                              width: 10,
                              height: 10,
                              borderRadius: 0.5,
                              bgcolor: c.color,
                              mx: "auto",
                            }}
                          />
                          <Typography sx={{ color: C.textMuted, fontSize: 10.5, mt: 0.25 }}>
                            {c.value}
                          </Typography>
                        </Box>
                      );
                    }
                  )}
                </Stack>
              </>
            )}
            {/* Saving belongs with the tools that produce the edit, not in a
                header on the far side of the window. */}
            <Tooltip title={displayedMask ? "" : "Show a segmentation first"}>
              <span>
                <Button
                  fullWidth
                  size="small"
                  variant="contained"
                  startIcon={<SaveIcon />}
                  disabled={!displayedMask || saving}
                  onClick={doSave}
                  sx={{
                    mt: 2,
                    bgcolor: C.accentDim,
                    textTransform: "none",
                    fontWeight: 600,
                    "&:hover": { bgcolor: C.accent },
                    "&.Mui-disabled": { bgcolor: C.surfaceInset, color: C.textFaint },
                  }}
                >
                  {saving ? "Saving…" : "Save annotation"}
                </Button>
              </span>
            </Tooltip>
          </Box>

          <SectionLabel>Volumes</SectionLabel>
          <Box sx={{ px: 2, pb: 2 }}>
            {totals.map((t) => (
              <Stack
                key={t.key}
                direction="row"
                justifyContent="space-between"
                sx={{ py: 0.5, borderBottom: BORDER }}
              >
                <Typography
                  sx={{
                    color: displayedMask === t.key ? C.text : C.textMuted,
                    fontSize: 12.5,
                    fontWeight: displayedMask === t.key ? 700 : 400,
                  }}
                >
                  {t.label}
                </Typography>
                <Typography
                  sx={{ color: C.text, fontSize: 12.5, fontVariantNumeric: "tabular-nums" }}
                >
                  {t.value !== null ? `${t.value.toFixed(2)} mL` : "—"}
                </Typography>
              </Stack>
            ))}

            {breakdown.length > 0 && (
              <Box sx={{ mt: 1.5 }}>
                <Typography sx={{ color: C.textFaint, fontSize: 11, mb: 0.5 }}>
                  {displayedMask === "c3" ? "3-class" : "4-class"} breakdown
                </Typography>
                {breakdown.map((b) => {
                  const pct =
                    b.value !== null && breakdownTotal
                      ? (b.value / breakdownTotal) * 100
                      : null;
                  return (
                    <Stack
                      key={b.name}
                      direction="row"
                      alignItems="center"
                      spacing={1}
                      sx={{ py: 0.4 }}
                    >
                      <Box
                        sx={{ width: 8, height: 8, borderRadius: 0.5, bgcolor: b.color, flexShrink: 0 }}
                      />
                      <Typography sx={{ color: C.textMuted, fontSize: 12, flex: 1 }}>
                        {b.name}
                      </Typography>
                      <Typography
                        sx={{ color: C.textFaint, fontSize: 11, fontVariantNumeric: "tabular-nums", width: 42, textAlign: "right" }}
                      >
                        {pct !== null ? `${pct.toFixed(0)}%` : ""}
                      </Typography>
                      <Typography
                        sx={{ color: C.text, fontSize: 12, fontVariantNumeric: "tabular-nums", width: 62, textAlign: "right" }}
                      >
                        {b.value !== null ? `${b.value.toFixed(2)} mL` : "—"}
                      </Typography>
                    </Stack>
                  );
                })}
              </Box>
            )}
          </Box>
        </Paper>

        {/* Right: viewer toolbar + panes */}
        <Box sx={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 1 }}>
          <Paper sx={{ ...panelSx, px: 1, py: 0.75 }}>
            <Stack direction="row" spacing={1.5} alignItems="center" flexWrap="wrap" useFlexGap>
              {/* base image — a viewer control, so it lives with the viewer */}
              <Stack direction="row" spacing={0.75} alignItems="center">
                <Typography sx={{ color: C.textFaint, fontSize: 11, fontWeight: 700, letterSpacing: 0.6 }}>
                  BASE
                </Typography>
                <ToggleButtonGroup
                  exclusive
                  size="small"
                  value={baseImg}
                  onChange={(_, v) => v && setBaseImg(v)}
                >
                  <ToggleButton value="fat" sx={toggleSx}>Fat</ToggleButton>
                  <Tooltip title={hasFF ? "" : "This case has no fat-fraction volume"}>
                    <span>
                      <ToggleButton value="ff" sx={toggleSx} disabled={!hasFF}>
                        Fat fraction
                      </ToggleButton>
                    </span>
                  </Tooltip>
                </ToggleButtonGroup>
              </Stack>

              <Divider orientation="vertical" flexItem sx={{ borderColor: C.border }} />

              {/* layout */}
              <Stack direction="row" spacing={0.75} alignItems="center">
                <GridViewIcon sx={{ fontSize: 15, color: C.textFaint }} />
                <ToggleButtonGroup
                  exclusive
                  size="small"
                  value={layout}
                  onChange={(_, v) => v && setLayout(v as LayoutMode)}
                >
                  {LAYOUTS.map((l) => (
                    <Tooltip key={l.mode} title={l.hint}>
                      <ToggleButton value={l.mode} sx={toggleSx}>
                        {l.label}
                      </ToggleButton>
                    </Tooltip>
                  ))}
                </ToggleButtonGroup>
              </Stack>

              <Divider orientation="vertical" flexItem sx={{ borderColor: C.border }} />

              {/* which pane "1" shows, and which pane is highlighted elsewhere */}
              <ToggleButtonGroup
                exclusive
                size="small"
                value={activePane}
                onChange={(_, v) => v !== null && setActivePane(v as number)}
              >
                {VIEWS.map((v, i) => (
                  <ToggleButton key={v.key} value={i} sx={toggleSx}>
                    {v.short}
                  </ToggleButton>
                ))}
              </ToggleButtonGroup>

              <Box sx={{ flex: 1 }} />
              <Typography sx={{ color: C.textFaint, fontSize: 11 }}>
                double-click a pane to expand · drag or scroll to move the crosshair
              </Typography>
            </Stack>
          </Paper>

          <ViewerGrid
            refs={refs}
            getViewers={getViewers}
            forceResizeAndDraw={forceResizeAndDraw}
            syncFrom={syncFrom}
            layout={layout}
            viewerOk={viewerOk}
            ready={attachReady}
            activePane={activePane}
            onActivePaneChange={setActivePane}
          />
        </Box>
      </Stack>
    </Box>
  );
}
