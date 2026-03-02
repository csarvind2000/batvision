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
  Chip,
  Divider,
  IconButton,
  Paper,
  Slider,
  Stack,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableRow,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from "@mui/material";

import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import VisibilityIcon from "@mui/icons-material/Visibility";
import VisibilityOffIcon from "@mui/icons-material/VisibilityOff";
import EditIcon from "@mui/icons-material/Edit";
import UndoIcon from "@mui/icons-material/Undo";
import DeleteSweepIcon from "@mui/icons-material/DeleteSweep";
import SaveIcon from "@mui/icons-material/Save";

import { apiBatReview, apiSaveBatAnnotation } from "../../api/client";
import { useNiivue4Up, makeBatLut } from "./useNiivue4Up";
import type { MaskType } from "./useNiivue4Up";

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

const toggleSx = {
  color: "#fff",
  borderColor: "#1f2937",
  bgcolor: "transparent",
  "&.Mui-selected": { color: "#fff", bgcolor: "#1f2937" },
  "&.Mui-disabled": {
    color: "rgba(255,255,255,0.35)",
    borderColor: "rgba(31,41,55,0.6)",
  },
};

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

const BORDER = "1px solid #1f2937";
const PANEL_BG = "#111827";
const SUB_BG = "#0b1220";
const MUTED_WHITE = { color: "rgba(255,255,255,0.78)" };

const MASK_BADGE: Record<MaskType, { tag: string; color: string }> = {
  binary: { tag: "BAT", color: "#ff0000" },
  c3: { tag: "C3", color: "#22c55e" },
  c4: { tag: "C4", color: "#f59e0b" },
};

const CLASS_CHIPS = [
  { label: "Class 1", color: "#ff0000", value: 1 },
  { label: "Class 2", color: "#00ff00", value: 2 },
  { label: "Class 3", color: "#0000ff", value: 3 },
  { label: "Class 4", color: "#ffff00", value: 4 },
];

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
  const [activeLabel, setActiveLabel] = useState<number>(1);

  const [saving, setSaving] = useState(false);

  const {
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
  } = useNiivue4Up();

  const baseLoadGen = useRef(0);

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
          // base changed => reset mask + tools
          unloadMask();
          setDisplayedMask(null);
          setEditMode("off");
          setActiveLabel(1);
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
      applyEdit("off", brushSize, 1);
      return;
    }

    const effectiveLabel = displayedMask === "binary" ? 1 : Math.max(1, Math.min(4, activeLabel));
    applyEdit(editMode, brushSize, effectiveLabel);
  }, [displayedMask, editMode, brushSize, activeLabel, applyEdit]);

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

      await apiSaveBatAnnotation(caseIdNum, {
        mask_type: displayedMask,
        filename,
        edited_mask_b64: edited_b64,
      });

      console.log("[BAT] save ok", { mask: displayedMask, filename, b64Len: edited_b64.length });
    } catch (e: any) {
      console.error(e);
      setErr(e?.message || "Save failed");
    } finally {
      setSaving(false);
    }
  }, [displayedMask, caseIdNum, exportEditedMaskB64]);

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

  // Error page
  if (err) {
    return (
      <Box sx={{ minHeight: "100vh", bgcolor: "#0f1115", p: 2 }}>
        <Button startIcon={<ArrowBackIcon />} onClick={() => navigate("/cases")} sx={{ color: "#fff" }}>
          Back
        </Button>
        <Typography sx={{ mt: 2, color: "#ff6b6b", whiteSpace: "pre-wrap" }}>{err}</Typography>
      </Box>
    );
  }

  // Loading
  if (!raw) {
    return (
      <Box sx={{ minHeight: "100vh", bgcolor: "#0f1115", p: 2 }}>
        <Typography sx={{ color: "#fff" }}>Loading review…</Typography>
      </Box>
    );
  }

  return (
    <Box sx={{ minHeight: "100vh", bgcolor: "#0f1115", p: 2 }}>
      <Paper sx={{ bgcolor: PANEL_BG, border: BORDER, borderRadius: 2, p: 2, mb: 2 }}>
        <Stack direction="row" spacing={2} alignItems="center">
          <Button startIcon={<ArrowBackIcon />} onClick={() => navigate("/cases")} sx={{ color: "#fff" }}>
            Back
          </Button>
          <Typography sx={{ color: "#fff", fontWeight: 900 }}>BAT Review</Typography>
          <Divider orientation="vertical" flexItem sx={{ borderColor: "#1f2937" }} />
          <Typography sx={MUTED_WHITE}>Patient: {info.patientName ?? "-"}</Typography>
          <Typography sx={MUTED_WHITE}>ID: {info.patientId ?? "-"}</Typography>
          <Box sx={{ flex: 1 }} />
          <Typography sx={{ color: "#a78bfa", fontWeight: 900 }}>{info.seriesType ?? "BAT"}</Typography>
        </Stack>
      </Paper>

      <Stack direction="row" spacing={2} sx={{ height: "calc(100vh - 120px)" }}>
        {/* Left */}
        <Paper sx={{ width: 380, bgcolor: PANEL_BG, border: BORDER, borderRadius: 2, overflow: "hidden" }}>
          <Box sx={{ p: 2, borderBottom: BORDER }}>
            <Stack direction="row" alignItems="center" justifyContent="space-between">
              <Typography sx={{ color: "#fff", fontWeight: 900 }}>Segmentations</Typography>

              <Stack direction="row" spacing={1}>
                <Tooltip title="Toggle edit tools">
                  <span>
                    <Button
                      size="small"
                      variant="contained"
                      startIcon={<EditIcon />}
                      disabled={!displayedMask}
                      onClick={() => setEditMode((m) => (m === "off" ? "draw" : "off"))}
                      sx={{ bgcolor: "#6d28d9", "&:hover": { bgcolor: "#5b21b6" }, color: "#fff" }}
                    >
                      Edit
                    </Button>
                  </span>
                </Tooltip>

                <Tooltip title="Save edited mask">
                  <span>
                    <Button
                      size="small"
                      variant="contained"
                      startIcon={<SaveIcon />}
                      disabled={!displayedMask || saving}
                      onClick={doSave}
                      sx={{ bgcolor: "#059669", "&:hover": { bgcolor: "#047857" }, color: "#fff" }}
                    >
                      Save
                    </Button>
                  </span>
                </Tooltip>
              </Stack>
            </Stack>

            <Stack direction="row" spacing={1} alignItems="center" sx={{ mt: 2 }}>
              <Typography sx={{ color: "rgba(255,255,255,0.75)", fontSize: 12, minWidth: 48 }}>
                Base:
              </Typography>
              <ToggleButtonGroup exclusive value={baseImg} onChange={(_, v) => v && setBaseImg(v)} size="small">
                <ToggleButton value="fat" sx={toggleSx}>FAT</ToggleButton>
                <ToggleButton value="ff" sx={toggleSx} disabled={!hasFF}>FAT FRACTION</ToggleButton>
              </ToggleButtonGroup>
            </Stack>

            {viewerOk && !attachReady && (
              <Typography sx={{ mt: 1, color: "#fbbf24", fontSize: 12 }}>Viewer initializing…</Typography>
            )}
            {!viewerOk && (
              <Typography sx={{ mt: 1, color: "#fbbf24", fontSize: 12 }}>WebGL not available</Typography>
            )}
          </Box>

          {/* Seg list */}
          <TableContainer sx={{ borderBottom: BORDER }}>
            <Table size="small">
              <TableBody>
                {segs.map((s, idx) => {
                  const checked = displayedMask === s.key;
                  const badge = MASK_BADGE[s.key];

                  return (
                    <TableRow key={s.key} sx={{ "& td": { borderBottom: BORDER, py: 1 } }}>
                      <TableCell sx={{ width: 32, color: "rgba(255,255,255,0.75)", fontSize: 12 }}>
                        {idx + 1}
                      </TableCell>

                      <TableCell sx={{ px: 1 }}>
                        <Stack direction="row" spacing={1} alignItems="center">
                          <Chip
                            label={badge.tag}
                            size="small"
                            sx={{
                              bgcolor: "transparent",
                              border: `1px solid ${badge.color}`,
                              color: badge.color,
                              fontWeight: 900,
                              height: 22,
                            }}
                          />
                          <Box sx={{ lineHeight: 1.1 }}>
                            <Typography sx={{ color: "#fff", fontSize: 13, fontWeight: 800 }}>
                              {s.label}
                            </Typography>
                            <Typography sx={{ color: "rgba(255,255,255,0.72)", fontSize: 12 }}>
                              {s.sub}
                            </Typography>
                          </Box>
                        </Stack>
                      </TableCell>

                      <TableCell align="right" sx={{ width: 92, pr: 1 }}>
                        <Tooltip title={checked ? "Hide" : "Show"}>
                          <span>
                            <IconButton
                              size="small"
                              onClick={() => toggleMask(s.key)}
                              sx={{ color: "#fff" }}
                              disabled={!viewerOk || !attachReady}
                            >
                              {checked ? <VisibilityIcon fontSize="small" /> : <VisibilityOffIcon fontSize="small" />}
                            </IconButton>
                          </span>
                        </Tooltip>

                        <Switch
                          size="small"
                          checked={checked}
                          onChange={() => toggleMask(s.key)}
                          disabled={!viewerOk || !attachReady}
                        />
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </TableContainer>

          {/* Tools */}
          <Box sx={{ p: 2, borderBottom: BORDER }}>
            <Typography sx={{ color: "rgba(255,255,255,0.75)", fontSize: 12, mb: 1 }}>Tools</Typography>

            <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
              <ToggleButtonGroup
                exclusive
                value={editMode}
                onChange={(_, v) => setEditMode((v || "off") as EditMode)}
                size="small"
                disabled={!displayedMask}
              >
                <ToggleButton value="off" sx={toggleSx}>OFF</ToggleButton>
                <ToggleButton value="draw" sx={toggleSx}>…DRAW</ToggleButton>
                <ToggleButton value="erase" sx={toggleSx}>…ERASE</ToggleButton>
              </ToggleButtonGroup>

              <Tooltip title="Undo">
                <span>
                  <IconButton size="small" sx={{ color: "#fff" }} disabled={!displayedMask} onClick={undo}>
                    <UndoIcon fontSize="small" />
                  </IconButton>
                </span>
              </Tooltip>

              <Tooltip title="Clear overlay">
                <span>
                  <IconButton size="small" sx={{ color: "#fff" }} disabled={!displayedMask} onClick={doClearDrawing}>
                    <DeleteSweepIcon fontSize="small" />
                  </IconButton>
                </span>
              </Tooltip>
            </Stack>

            {/* Brush */}
            <Typography sx={{ color: "rgba(255,255,255,0.75)", fontSize: 12, mt: 2 }}>
              Brush Size
            </Typography>
            <Slider
              min={1}
              max={40}
              step={1}
              value={brushSize}
              onChange={(_, v) => setBrushSize(v as number)}
              disabled={!displayedMask}
              size="small"
            />

            {/* Opacity */}
            <Typography sx={{ color: "rgba(255,255,255,0.75)", fontSize: 12, mt: 1 }}>
              Opacity: {(maskOpacity * 100).toFixed(0)}%
            </Typography>
            <Slider
              min={0}
              max={1}
              step={0.01}
              value={maskOpacity}
              onChange={(_, v) => setMaskOpacityLocal(v as number)}
              disabled={!displayedMask}
              size="small"
            />

            {/* Color palette / label selection */}
            <Typography sx={{ color: "rgba(255,255,255,0.75)", fontSize: 12, mt: 2 }}>
              Label / Color
            </Typography>

            <Stack direction="row" spacing={1} flexWrap="wrap" sx={{ mt: 1 }}>
              {displayedMask === "binary" ? (
                <Chip
                  label="Binary (Class 1 - Red)"
                  size="small"
                  sx={{ bgcolor: "transparent", border: "1px solid #ff0000", color: "#fff" }}
                />
              ) : (
                CLASS_CHIPS
                  .filter((c) => (displayedMask === "c3" ? c.value <= 3 : true))
                  .map((c) => (
                    <Chip
                      key={c.value}
                      onClick={() => setActiveLabel(c.value)}
                      label={c.label}
                      size="small"
                      sx={{
                        cursor: "pointer",
                        bgcolor: activeLabel === c.value ? "rgba(255,255,255,0.12)" : "transparent",
                        border: `1px solid ${c.color}`,
                        color: "#fff",
                        "&:hover": { bgcolor: "rgba(255,255,255,0.10)" },
                      }}
                      icon={
                        <span
                          style={{
                            width: 10,
                            height: 10,
                            borderRadius: 2,
                            background: c.color,
                            display: "inline-block",
                            marginLeft: 6,
                          }}
                        />
                      }
                    />
                  ))
              )}
            </Stack>
          </Box>

          {/* Results */}
          <Box sx={{ p: 2 }}>
            <Typography sx={{ color: "#fff", fontWeight: 900, mb: 1 }}>Results</Typography>

            <TableContainer component={Paper} sx={{ bgcolor: SUB_BG, border: BORDER }}>
              <Table size="small">
                <TableBody>
                  {displayedMask === "binary" && (
                    <>
                      <ResRow name="BAT (Binary)" val={binaryTotal} />
                      <ResRow name="Total" val={binaryTotal} isBold />
                    </>
                  )}

                  {displayedMask === "c3" && (
                    <>
                      <ResRow name="Class 1 (Muscle)" val={toNum(c3b.class1_muscle_ml)} />
                      <ResRow name="Class 2 (Brown Fat)" val={toNum(c3b.class2_brownfat_ml)} />
                      <ResRow name="Class 3 (Mix+White)" val={toNum(c3b.class3_mixwhite_ml)} />
                      <ResRow name="Total" val={c3Total} isBold />
                    </>
                  )}

                  {displayedMask === "c4" && (
                    <>
                      <ResRow name="Class 1 (Muscle)" val={toNum(c4b.class1_muscle_ml)} />
                      <ResRow name="Class 2 (Brown Fat)" val={toNum(c4b.class2_brownfat_ml)} />
                      <ResRow name="Class 3 (Mix Fat)" val={toNum(c4b.class3_mixfat_ml)} />
                      <ResRow name="Class 4 (White Fat)" val={toNum(c4b.class4_whitefat_ml)} />
                      <ResRow name="Total" val={c4Total} isBold />
                    </>
                  )}

                  {!displayedMask && (
                    <TableRow>
                      <TableCell colSpan={2} sx={{ color: "rgba(255,255,255,0.65)", fontSize: 12 }}>
                        Select a segmentation to view volumes.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </TableContainer>
          </Box>
        </Paper>

        {/* Right: 4 views */}
        <Box
          sx={{
            flex: 1,
            minWidth: 0,
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gridTemplateRows: "1fr 1fr",
            gap: 2,
          }}
        >
          <ViewerCard title="Axial" canvasRef={refs.axialRef} disabled={!viewerOk} />
          <ViewerCard title="3D" canvasRef={refs.render3DRef} disabled={!viewerOk} />
          <ViewerCard title="Sagittal" canvasRef={refs.sagittalRef} disabled={!viewerOk} />
          <ViewerCard title="Coronal" canvasRef={refs.coronalRef} disabled={!viewerOk} />
        </Box>
      </Stack>
    </Box>
  );
}

function ResRow({ name, val, isBold }: { name: string; val: number | null; isBold?: boolean }) {
  return (
    <TableRow>
      <TableCell sx={{ color: "#fff", fontSize: 12, borderBottom: "1px solid #1f2937" }}>
        {name}
      </TableCell>
      <TableCell
        align="right"
        sx={{
          color: "#fff",
          fontSize: 12,
          fontWeight: isBold ? 900 : 700,
          borderBottom: "1px solid #1f2937",
          whiteSpace: "nowrap",
        }}
      >
        {val !== null ? `${val.toFixed(2)} ml` : "-"}
      </TableCell>
    </TableRow>
  );
}

function ViewerCard({
  title,
  canvasRef,
  disabled,
}: {
  title: string;
  canvasRef: any;
  disabled: boolean;
}) {
  return (
    <Paper
      elevation={0}
      sx={{
        bgcolor: "#111827",
        border: "1px solid #1f2937",
        borderRadius: 2,
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
      }}
    >
      <Box sx={{ p: 1, borderBottom: "1px solid #1f2937" }}>
        <Typography sx={{ color: "#fff", fontWeight: 900 }}>{title}</Typography>
      </Box>

      <Box sx={{ flex: 1, minHeight: 0, position: "relative" }}>
        <canvas ref={canvasRef} style={{ width: "100%", height: "100%", display: "block" }} />

        {disabled && (
          <Box
            sx={{
              position: "absolute",
              inset: 0,
              display: "grid",
              placeItems: "center",
              pointerEvents: "none",
            }}
          >
            <Typography sx={{ color: "rgba(255,255,255,0.7)", fontSize: 13 }}>
              WebGL not available
            </Typography>
          </Box>
        )}
      </Box>
    </Paper>
  );
}