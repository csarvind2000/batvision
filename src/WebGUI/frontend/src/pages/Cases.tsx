// src/pages/Cases.tsx
import * as React from "react";
import { useNavigate } from "react-router-dom";
import {
  Box,
  Stack,
  Typography,
  TextField,
  Button,
  IconButton,
  Dialog,
  DialogContent,
  DialogTitle,
  DialogActions,
  LinearProgress,
  MenuItem,
  Select,
  FormControl,
  Paper,
  Checkbox,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Tooltip,
  CircularProgress,
  InputAdornment,
} from "@mui/material";
import CloudUploadIcon from "@mui/icons-material/CloudUpload";
import RefreshIcon from "@mui/icons-material/Refresh";
import TableChartIcon from "@mui/icons-material/TableChart";
import CloseIcon from "@mui/icons-material/Close";
import SearchIcon from "@mui/icons-material/Search";
import DownloadIcon from "@mui/icons-material/Download";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import ReplayIcon from "@mui/icons-material/Replay";
import ErrorOutlineIcon from "@mui/icons-material/ErrorOutline";

import {
  apiListCases,
  apiUploadOneCase,
  apiTriggerProcessing,
  apiGetCaseStatus,
  apiDeleteCases,
  apiCohortExport,
} from "../api/client";
import { C, BORDER, panelSx } from "./batReview/theme";

type CaseStatus = "PROCESSING" | "FAILED" | "READY";

type CaseItem = {
  id: string;
  subject_id?: string;
  status: CaseStatus;
  progress?: number;
  status_message?: string;
  created_at?: string;
  fat_path?: string;
  ff_path?: string;
  [key: string]: any;
};

const STATUS_META: Record<CaseStatus, { label: string; color: string }> = {
  READY: { label: "Ready to review", color: C.ok },
  PROCESSING: { label: "Processing", color: C.warn },
  FAILED: { label: "Failed", color: C.danger },
};

/** A coloured dot plus a word reads faster down a column than a boxed chip. */
function StatusCell({ status }: { status: CaseStatus }) {
  const meta = STATUS_META[status] ?? { label: status, color: C.textMuted };
  return (
    <Stack direction="row" spacing={1} alignItems="center">
      <Box
        sx={{
          width: 7,
          height: 7,
          borderRadius: "50%",
          bgcolor: meta.color,
          flexShrink: 0,
          // a soft halo keeps the dot legible against the row hover colour
          boxShadow: `0 0 0 3px ${meta.color}22`,
        }}
      />
      <Typography sx={{ fontSize: 12.5, color: C.text, whiteSpace: "nowrap" }}>
        {meta.label}
      </Typography>
    </Stack>
  );
}

function formatDate(iso?: string) {
  if (!iso) return "-";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "-" : d.toLocaleString();
}

/**
 * "3 min ago" scans far better in a worklist than a repeated absolute
 * timestamp; the exact time stays available on hover.
 */
function relativeTime(iso?: string): string {
  if (!iso) return "—";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "—";
  const secs = Math.round((Date.now() - then) / 1000);
  if (secs < 45) return "just now";
  const steps: [number, string][] = [
    [60, "min"],
    [60, "hr"],
    [24, "day"],
  ];
  let value = secs / 60;
  let unit = "min";
  for (let i = 1; i < steps.length; i++) {
    if (Math.abs(value) < steps[i][0]) break;
    value /= steps[i][0];
    unit = steps[i][1];
  }
  const n = Math.round(value);
  return `${n} ${unit}${Math.abs(n) === 1 ? "" : "s"} ago`;
}

export default function Cases() {
  const navigate = useNavigate();

  const [cases, setCases] = React.useState<CaseItem[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [listError, setListError] = React.useState("");
  const [exportBusy, setExportBusy] = React.useState(false);
  const [selected, setSelected] = React.useState<Record<string, boolean>>({});
  const [search, setSearch] = React.useState("");
  const [statusFilter, setStatusFilter] = React.useState<"" | CaseStatus>("");

  const [uploadOpen, setUploadOpen] = React.useState(false);
  const [uploadError, setUploadError] = React.useState<string>("");
  const [uploadBusy, setUploadBusy] = React.useState(false);
  const [uploadStatusText, setUploadStatusText] = React.useState<string>("");

  // Delete confirmation
  const [deleteOpen, setDeleteOpen] = React.useState(false);
  const [deleteBusy, setDeleteBusy] = React.useState(false);
  const [deleteError, setDeleteError] = React.useState("");

  const fileInputRef = React.useRef<HTMLInputElement | null>(null);
  const folderInputRef = React.useRef<HTMLInputElement | null>(null);

  const refresh = React.useCallback(async () => {
    try {
      setListError("");
      const data = await apiListCases();
      setCases(
        (data || []).map((c: any) => ({
          ...c,
          subject_id:
            c.subject_id ||
            c.subjectId ||
            c.case_id ||
            c.caseId ||
            c.case_name ||
            c.caseName ||
            c.name ||
            c.subject,
        }))
      );
    } catch (e: any) {
      // Previously this rejected unhandled and the page just stayed blank.
      setListError(e?.message || "Could not load cases.");
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    refresh();
  }, [refresh]);

  // Poll processing
  React.useEffect(() => {
    const processing = cases.filter((c) => c.status === "PROCESSING").map((c) => c.id);
    if (processing.length === 0) return;

    const t = window.setInterval(async () => {
      try {
        const updates = await Promise.all(
          processing.map(async (id) => ({ id, ...(await apiGetCaseStatus(id)) }))
        );

        setCases((prev) =>
          prev.map((c) => {
            const u = updates.find((x) => x.id === c.id);
            if (!u) return c;
            return {
              ...c,
              status: u.status,
              progress: u.progress,
              status_message: u.statusMessage ?? u.status_message,
            };
          })
        );
      } catch {
        // ignore
      }
    }, 2500);

    return () => window.clearInterval(t);
  }, [cases]);

  const filtered = cases.filter((c) => {
    const sid = (c.subject_id || "").toLowerCase();
    const matchesSearch = !search || sid.includes(search.toLowerCase());
    const matchesStatus = !statusFilter || c.status === statusFilter;
    return matchesSearch && matchesStatus;
  });

  const selectedIds = Object.keys(selected).filter((id) => selected[id]);

  // naming rule
  function isValidNiftiName(name: string) {
    const lower = name.toLowerCase();
    return (
      (lower.endsWith(".nii") || lower.endsWith(".nii.gz")) &&
      (lower.includes("_f_0000") || lower.includes("_ff_0001"))
    );
  }

  // ---- MULTI-CASE FOLDER UPLOAD ----
  function getSubjectFromFile(f: any) {
    // folder upload gives: "010-04002/010-04002_F_0000.nii.gz"
    const rel: string = f.webkitRelativePath || "";
    if (rel.includes("/")) return rel.split("/")[0];

    // fallback: prefix before _F_0000 or _FF_0001
    const n = (f.name || "").toLowerCase();
    const idxF = n.indexOf("_f_0000");
    const idxFF = n.indexOf("_ff_0001");
    const idx = idxF >= 0 ? idxF : idxFF;
    if (idx > 0) return f.name.substring(0, idx);
    return "unknown";
  }

  function validateGroup(files: File[]) {
    const names = files.map((x) => (x.name || "").toLowerCase());
    const hasF = names.some((n) => n.includes("_f_0000"));
    const hasFF = names.some((n) => n.includes("_ff_0001"));
    return hasF && hasFF;
  }

  const onFilesChosen = async (fileList: FileList | null) => {
    setUploadError("");
    setUploadStatusText("");
    if (!fileList || fileList.length === 0) return;

    const all = Array.from(fileList) as any[];
    const nifti = all.filter((f) => isValidNiftiName(f.name));

    if (nifti.length === 0) {
      setUploadError("No valid NIfTI files found. Expect *_F_0000.nii.gz and *_FF_0001.nii.gz");
      return;
    }

    // group by foldername (= case name)
    const groups = new Map<string, File[]>();
    for (const f of nifti) {
      const sid = getSubjectFromFile(f);
      if (!groups.has(sid)) groups.set(sid, []);
      groups.get(sid)!.push(f);
    }

    // validate each group
    const bad: string[] = [];
    for (const [sid, files] of groups.entries()) {
      if (!validateGroup(files)) bad.push(sid);
    }
    if (bad.length > 0) {
      setUploadError(
        `These folders are missing required pairs (_F_0000 and _FF_0001): ${bad.slice(0, 10).join(", ")}${
          bad.length > 10 ? ` ... (+${bad.length - 10} more)` : ""
        }`
      );
      return;
    }

    try {
      setUploadBusy(true);

      const createdAll: string[] = [];
      const total = groups.size;
      let i = 0;

      for (const [sid, files] of groups.entries()) {
        i += 1;
        setUploadStatusText(`Uploading ${i}/${total}: ${sid}`);

        // ✅ upload ONE case
        const resp = await apiUploadOneCase(files, sid);
        const createdIds: string[] = resp.created_case_ids || resp.createdCaseIds || [];

        createdAll.push(...createdIds);

        // ✅ refresh AFTER EACH upload so UI updates immediately
        await refresh();
      }

      // trigger processing for all new cases
      if (createdAll.length > 0) {
        setUploadStatusText(`Triggering AI for ${createdAll.length} case(s)...`);
        await apiTriggerProcessing(createdAll);
        await refresh();
      }

      setUploadStatusText("");
      setUploadOpen(false);
    } catch (e: any) {
      setUploadError(e?.message || "Upload failed.");
    } finally {
      setUploadBusy(false);
    }
  };

  const exportSelected = React.useCallback(async () => {
    if (selectedIds.length === 0) return;
    try {
      setExportBusy(true);
      const { blob, filename } = await apiCohortExport("xlsx", selectedIds);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e: any) {
      setListError(e?.message || "Export failed.");
    } finally {
      setExportBusy(false);
    }
  }, [selectedIds]);

  const allShownSelected =
    filtered.length > 0 && filtered.every((c) => selected[c.id]);

  const toggleAllShown = () =>
    setSelected((prev) => {
      const next = { ...prev };
      if (allShownSelected) filtered.forEach((c) => delete next[c.id]);
      else filtered.forEach((c) => (next[c.id] = true));
      return next;
    });

  // ---- DELETE ----
  const openDeleteDialog = () => {
    if (selectedIds.length === 0) return;
    setDeleteError("");
    setDeleteOpen(true);
  };

  const closeDeleteDialog = () => {
    if (deleteBusy) return;
    setDeleteOpen(false);
  };

  const onConfirmDelete = async () => {
    if (selectedIds.length === 0) return;

    try {
      setDeleteBusy(true);
      setDeleteError("");
      await apiDeleteCases(selectedIds);

      setSelected({});
      await refresh();

      setDeleteOpen(false);
    } catch (e: any) {
      setDeleteError(e?.message || "Delete failed.");
    } finally {
      setDeleteBusy(false);
    }
  };

  const readyCount = cases.filter((c) => c.status === "READY").length;
  const busyCount = cases.filter((c) => c.status === "PROCESSING").length;

  const headCellSx = {
    bgcolor: C.surfaceInset,
    borderBottom: BORDER,
    color: C.textFaint,
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: 0.6,
    textTransform: "uppercase" as const,
    py: 1,
  };

  return (
    <Box
      sx={{
        height: "100vh",
        bgcolor: C.bg,
        p: 2.5,
        display: "flex",
        flexDirection: "column",
        gap: 2,
      }}
    >
      {/* ── header ─────────────────────────────────────────────────────── */}
      <Stack direction="row" alignItems="center" spacing={1.5}>
        <Box>
          <Typography sx={{ color: C.text, fontWeight: 800, fontSize: 20, lineHeight: 1.2 }}>
            BAT Cases
          </Typography>
          <Typography sx={{ color: C.textFaint, fontSize: 12 }}>
            {cases.length} case{cases.length === 1 ? "" : "s"} · {readyCount} ready
            {busyCount > 0 ? ` · ${busyCount} processing` : ""}
          </Typography>
        </Box>

        <Box sx={{ flex: 1 }} />

        <Tooltip title="Refresh">
          <IconButton onClick={refresh} sx={{ color: C.textMuted }}>
            <RefreshIcon fontSize="small" />
          </IconButton>
        </Tooltip>

        <Button
          variant="outlined"
          size="small"
          startIcon={<TableChartIcon />}
          onClick={() => navigate("/cohort")}
          sx={{
            color: C.text,
            borderColor: C.border,
            textTransform: "none",
            "&:hover": { borderColor: C.accent, bgcolor: "rgba(124,156,245,0.08)" },
          }}
        >
          Cohort
        </Button>

        <Button
          variant="contained"
          size="small"
          startIcon={<CloudUploadIcon />}
          onClick={() => setUploadOpen(true)}
          sx={{
            bgcolor: C.accentDim,
            textTransform: "none",
            fontWeight: 600,
            "&:hover": { bgcolor: C.accent },
          }}
        >
          Upload cases
        </Button>
      </Stack>

      {/* ── filters + bulk actions ─────────────────────────────────────── */}
      <Paper sx={{ ...panelSx, px: 1.25, py: 1 }}>
        <Stack direction="row" spacing={1.25} alignItems="center" flexWrap="wrap" useFlexGap>
          <TextField
            size="small"
            placeholder="Search subject ID"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            InputProps={{
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon sx={{ fontSize: 17, color: C.textFaint }} />
                </InputAdornment>
              ),
            }}
            sx={{
              width: 260,
              "& .MuiOutlinedInput-root": { color: C.text, fontSize: 13, bgcolor: C.surfaceInset },
              "& fieldset": { borderColor: C.border },
              "& input::placeholder": { color: C.textFaint, opacity: 1 },
            }}
          />

          <FormControl size="small" sx={{ minWidth: 170 }}>
            <Select
              displayEmpty
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as any)}
              sx={{
                bgcolor: C.surfaceInset,
                color: C.text,
                fontSize: 13,
                "& fieldset": { borderColor: C.border },
                ".MuiSvgIcon-root": { color: C.textFaint },
              }}
            >
              <MenuItem value="">All statuses</MenuItem>
              <MenuItem value="READY">Ready to review</MenuItem>
              <MenuItem value="PROCESSING">Processing</MenuItem>
              <MenuItem value="FAILED">Failed</MenuItem>
            </Select>
          </FormControl>

          <Box sx={{ flex: 1 }} />

          {/* Bulk actions only exist once something is selected, so the bar is
              not a row of permanently greyed-out buttons. */}
          {selectedIds.length > 0 && (
            <>
              <Typography sx={{ color: C.textMuted, fontSize: 12.5 }}>
                {selectedIds.length} selected
              </Typography>
              <Button
                size="small"
                startIcon={<DownloadIcon />}
                onClick={exportSelected}
                disabled={exportBusy}
                sx={{ color: C.text, textTransform: "none" }}
              >
                {exportBusy ? "Exporting…" : "Export"}
              </Button>
              <Button
                size="small"
                startIcon={<DeleteOutlineIcon />}
                onClick={openDeleteDialog}
                sx={{ color: C.danger, textTransform: "none" }}
              >
                Delete
              </Button>
              <Button
                size="small"
                onClick={() => setSelected({})}
                sx={{ color: C.textFaint, textTransform: "none" }}
              >
                Clear
              </Button>
            </>
          )}
        </Stack>
      </Paper>

      {listError && (
        <Paper sx={{ ...panelSx, p: 1.5, borderColor: C.danger }}>
          <Stack direction="row" spacing={1} alignItems="center">
            <ErrorOutlineIcon sx={{ color: C.danger, fontSize: 18 }} />
            <Typography sx={{ color: C.danger, fontSize: 13 }}>{listError}</Typography>
          </Stack>
        </Paper>
      )}

      {/* ── worklist ───────────────────────────────────────────────────── */}
      <Paper
        sx={{
          ...panelSx,
          flex: 1,
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        {loading ? (
          <Box sx={{ flex: 1, display: "grid", placeItems: "center" }}>
            <CircularProgress size={26} sx={{ color: C.accent }} />
          </Box>
        ) : filtered.length === 0 ? (
          <Box sx={{ flex: 1, display: "grid", placeItems: "center", px: 3 }}>
            <Stack spacing={1} alignItems="center">
              <Typography sx={{ color: C.textMuted, fontSize: 14 }}>
                {cases.length === 0 ? "No cases yet" : "No case matches these filters"}
              </Typography>
              <Typography sx={{ color: C.textFaint, fontSize: 12.5, textAlign: "center" }}>
                {cases.length === 0
                  ? "Upload a folder of subjects to get started — each subfolder becomes a case."
                  : "Try clearing the search box or the status filter."}
              </Typography>
              {cases.length === 0 && (
                <Button
                  variant="outlined"
                  size="small"
                  startIcon={<CloudUploadIcon />}
                  onClick={() => setUploadOpen(true)}
                  sx={{ mt: 1, color: C.text, borderColor: C.border, textTransform: "none" }}
                >
                  Upload cases
                </Button>
              )}
            </Stack>
          </Box>
        ) : (
          <TableContainer sx={{ flex: 1 }}>
            <Table size="small" stickyHeader>
              <TableHead>
                <TableRow>
                  <TableCell padding="checkbox" sx={headCellSx}>
                    <Checkbox
                      size="small"
                      checked={allShownSelected}
                      indeterminate={!allShownSelected && filtered.some((c) => selected[c.id])}
                      onChange={toggleAllShown}
                      sx={{ color: C.textFaint, "&.Mui-checked": { color: C.accent } }}
                    />
                  </TableCell>
                  <TableCell sx={headCellSx}>Subject</TableCell>
                  <TableCell sx={{ ...headCellSx, width: 260 }}>Status</TableCell>
                  <TableCell sx={{ ...headCellSx, width: 150 }}>Uploaded</TableCell>
                  <TableCell sx={{ ...headCellSx, width: 190 }} align="right">
                    Actions
                  </TableCell>
                </TableRow>
              </TableHead>

              <TableBody>
                {filtered.map((c) => {
                  const isSelected = !!selected[c.id];
                  return (
                    <TableRow
                      key={c.id}
                      hover
                      selected={isSelected}
                      onDoubleClick={() =>
                        c.status === "READY" && navigate(`/analysis/${c.id}/review`)
                      }
                      sx={{
                        cursor: c.status === "READY" ? "pointer" : "default",
                        "& td": { borderBottom: BORDER, py: 0.75 },
                        "&.Mui-selected, &.Mui-selected:hover": {
                          bgcolor: "rgba(124,156,245,0.10)",
                        },
                      }}
                    >
                      <TableCell padding="checkbox">
                        <Checkbox
                          size="small"
                          checked={isSelected}
                          onChange={(e) =>
                            setSelected((prev) => ({ ...prev, [c.id]: e.target.checked }))
                          }
                          onDoubleClick={(e) => e.stopPropagation()}
                          sx={{ color: C.textFaint, "&.Mui-checked": { color: C.accent } }}
                        />
                      </TableCell>

                      <TableCell>
                        <Typography
                          sx={{
                            color: C.text,
                            fontSize: 13.5,
                            fontWeight: 700,
                            fontVariantNumeric: "tabular-nums",
                          }}
                        >
                          {c.subject_id || c.case_id || c.case_name || "(no subject id)"}
                        </Typography>
                        {c.status === "FAILED" && c.status_message && (
                          <Tooltip title={c.status_message}>
                            <Typography
                              sx={{
                                color: C.danger,
                                fontSize: 11.5,
                                maxWidth: 560,
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                              }}
                            >
                              {c.status_message}
                            </Typography>
                          </Tooltip>
                        )}
                      </TableCell>

                      <TableCell>
                        <StatusCell status={c.status} />
                        {c.status === "PROCESSING" && (
                          <Box sx={{ mt: 0.75, maxWidth: 220 }}>
                            <LinearProgress
                              variant={
                                typeof c.progress === "number" ? "determinate" : "indeterminate"
                              }
                              value={c.progress ?? 0}
                              sx={{
                                height: 3,
                                borderRadius: 999,
                                bgcolor: C.surfaceInset,
                                "& .MuiLinearProgress-bar": { bgcolor: C.warn },
                              }}
                            />
                            <Typography sx={{ color: C.textFaint, fontSize: 11, mt: 0.25 }}>
                              {c.status_message ?? "Processing…"}
                              {typeof c.progress === "number" ? ` · ${c.progress}%` : ""}
                            </Typography>
                          </Box>
                        )}
                      </TableCell>

                      <TableCell>
                        <Tooltip title={formatDate(c.created_at)}>
                          <Typography sx={{ color: C.textMuted, fontSize: 12.5 }}>
                            {relativeTime(c.created_at)}
                          </Typography>
                        </Tooltip>
                      </TableCell>

                      <TableCell align="right">
                        <Stack direction="row" spacing={0.75} justifyContent="flex-end">
                          <Button
                            size="small"
                            variant={c.status === "READY" ? "contained" : "outlined"}
                            disabled={c.status !== "READY"}
                            onClick={() => navigate(`/analysis/${c.id}/review`)}
                            sx={{
                              textTransform: "none",
                              minWidth: 78,
                              ...(c.status === "READY"
                                ? { bgcolor: C.accentDim, "&:hover": { bgcolor: C.accent } }
                                : { color: C.textFaint, borderColor: C.border }),
                            }}
                          >
                            Review
                          </Button>
                          <Tooltip title="Re-run AI on this case">
                            <span>
                              <IconButton
                                size="small"
                                disabled={c.status === "PROCESSING"}
                                onClick={async () => {
                                  await apiTriggerProcessing([c.id]);
                                  await refresh();
                                }}
                                sx={{ color: C.textMuted, "&:hover": { color: C.text } }}
                              >
                                <ReplayIcon sx={{ fontSize: 17 }} />
                              </IconButton>
                            </span>
                          </Tooltip>
                        </Stack>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </TableContainer>
        )}
      </Paper>

      {/* Delete Confirmation */}
      <Dialog open={deleteOpen} onClose={closeDeleteDialog} maxWidth="md" fullWidth>
        <DialogTitle sx={{ bgcolor: C.surface, color: C.text, fontWeight: 800 }}>
          Delete Confirmation
        </DialogTitle>

        <DialogContent sx={{ bgcolor: C.surface, color: C.text, pt: 2 }}>
          <Typography sx={{ color: C.textMuted, mb: 1 }}>
            Are you sure you want to delete <b>{selectedIds.length}</b> case(s)?
          </Typography>

          <Typography sx={{ color: C.danger, fontWeight: 700 }}>
            This action cannot be undone
          </Typography>

          {deleteError && <Typography sx={{ color: C.danger, mt: 1 }}>{deleteError}</Typography>}
        </DialogContent>

        <DialogActions sx={{ bgcolor: C.surface, p: 2 }}>
          <Button
            variant="outlined"
            onClick={closeDeleteDialog}
            disabled={deleteBusy}
            sx={{
              flex: 1,
              borderColor: C.textMuted,
              color: C.text,
              textTransform: "none",
              borderRadius: 2,
              height: 46,
            }}
          >
            Cancel
          </Button>

          <Button
            variant="contained"
            onClick={onConfirmDelete}
            disabled={deleteBusy || selectedIds.length === 0}
            sx={{
              flex: 1,
              bgcolor: C.danger,
              "&:hover": { bgcolor: "#dc4c4c" },
              textTransform: "none",
              borderRadius: 2,
              height: 46,
            }}
          >
            {deleteBusy ? "Deleting…" : `Delete ${selectedIds.length} case${selectedIds.length === 1 ? "" : "s"}`}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Upload Dialog */}
      <Dialog open={uploadOpen} onClose={() => (uploadBusy ? null : setUploadOpen(false))} maxWidth="md" fullWidth>
        <DialogContent sx={{ bgcolor: C.surface, color: C.text, position: "relative", p: 3 }}>
          <IconButton
            onClick={() => setUploadOpen(false)}
            disabled={uploadBusy}
            sx={{ position: "absolute", right: 10, top: 10, color: C.textMuted }}
          >
            <CloseIcon />
          </IconButton>

          <Typography variant="h6" sx={{ fontWeight: 800 }}>
            Upload BAT Case(s)
          </Typography>

          <Typography variant="body2" sx={{ color: C.textFaint, mb: 2 }}>
            Naming rule:
            <br />
            <b>&lt;SUBJECT&gt;_F_0000.nii.gz</b> = FAT
            <br />
            <b>&lt;SUBJECT&gt;_FF_0001.nii.gz</b> = FAT FRACTION
          </Typography>

          {uploadError && <Typography sx={{ color: C.danger, mb: 2 }}>{uploadError}</Typography>}
          {uploadStatusText && <Typography sx={{ color: C.textMuted, mb: 2 }}>{uploadStatusText}</Typography>}

          <Box
            sx={{
              border: `2px dashed ${C.border}`,
              borderRadius: 2,
              p: 5,
              textAlign: "center",
              bgcolor: C.surfaceInset,
              opacity: uploadBusy ? 0.6 : 1,
            }}
          >
            <CloudUploadIcon sx={{ fontSize: 44, color: C.accent }} />
            <Typography sx={{ mt: 1, mb: 2 }}>
              Select a folder. Subfolder names will become case names.
            </Typography>

            <Stack direction="row" justifyContent="center" spacing={1.5}>
              <Button
                variant="outlined"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploadBusy}
                sx={{ borderColor: C.border, color: C.text, textTransform: "none" }}
              >
                Browse File(s)
              </Button>

              <Button
                variant="outlined"
                onClick={() => folderInputRef.current?.click()}
                disabled={uploadBusy}
                sx={{ borderColor: C.border, color: C.text, textTransform: "none" }}
              >
                Select Folder (Parent)
              </Button>
            </Stack>

            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept=".nii,.nii.gz"
              style={{ display: "none" }}
              onChange={(e) => {
                onFilesChosen(e.target.files);
                e.currentTarget.value = "";
              }}
            />

            <input
              ref={folderInputRef}
              type="file"
              multiple
              // @ts-ignore
              webkitdirectory=""
              style={{ display: "none" }}
              onChange={(e) => {
                onFilesChosen(e.target.files);
                e.currentTarget.value = "";
              }}
            />
          </Box>
        </DialogContent>
      </Dialog>
    </Box>
  );
}