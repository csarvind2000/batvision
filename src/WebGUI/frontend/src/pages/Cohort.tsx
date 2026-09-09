// Cohort view: every analysed case as one row of volumes, with Excel/CSV export.
//
// Population work means reading across subjects rather than one at a time, so
// this is deliberately a sheet — sortable, filterable, selectable — and not a
// dashboard. The numbers come from each case's bat_metrics.json via /api/cohort/,
// so this screen and the review screen can never disagree.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Box,
  Button,
  Checkbox,
  Chip,
  CircularProgress,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TableSortLabel,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from "@mui/material";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import DownloadIcon from "@mui/icons-material/Download";
import RefreshIcon from "@mui/icons-material/Refresh";

import { apiCohort, apiCohortExport } from "../api/client";
import type { CohortPayload, CohortRow, CohortStat } from "../api/client";
import { C, BORDER, panelSx, toggleSx } from "./batReview/theme";

type ColumnGroup = "identity" | "volumes" | "qc";

const GROUPS: { key: ColumnGroup; label: string }[] = [
  { key: "identity", label: "Identity" },
  { key: "volumes", label: "Volumes" },
  { key: "qc", label: "QC" },
];

// Headline tiles. Deliberately not a "% brown fat" tile: the classes are
// percentile bands of each subject's own fat-fraction distribution, so every
// subject is 20/40/40 by construction and the share is a constant, not a
// measurement. Voxel volume earns its place instead — it genuinely varies
// between acquisitions and decides whether two rows are comparable at all.
const HEADLINE = [
  { key: "binary_total_ml", label: "BAT total", unit: "mL" },
  { key: "c3_brownfat_ml", label: "Brown fat", unit: "mL" },
  { key: "voxel_volume_ml", label: "Voxel volume", unit: "mL" },
] as const;

function fmt(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "number") {
    return Number.isInteger(value) ? String(value) : value.toFixed(2);
  }
  return String(value);
}

function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function StatTile({ label, unit, stat }: { label: string; unit: string; stat?: CohortStat }) {
  const n = stat?.n ?? 0;
  return (
    <Paper sx={{ ...panelSx, p: 1.5, minWidth: 178, flex: "1 1 178px" }}>
      <Typography sx={{ color: C.textFaint, fontSize: 11, fontWeight: 700, letterSpacing: 0.6 }}>
        {label.toUpperCase()}
      </Typography>
      <Stack direction="row" alignItems="baseline" spacing={0.75} sx={{ mt: 0.5 }}>
        <Typography sx={{ color: C.text, fontSize: 26, fontWeight: 800, lineHeight: 1.1 }}>
          {n ? fmt(stat?.mean) : "—"}
        </Typography>
        <Typography sx={{ color: C.textFaint, fontSize: 12 }}>{unit}</Typography>
      </Stack>
      <Typography sx={{ color: C.textMuted, fontSize: 11, mt: 0.25 }}>
        {n
          ? `mean · SD ${fmt(stat?.sd)} · range ${fmt(stat?.min)}–${fmt(stat?.max)} · n=${n}`
          : "no measurements yet"}
      </Typography>
    </Paper>
  );
}

export default function Cohort() {
  const navigate = useNavigate();

  const [data, setData] = useState<CohortPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState<"" | "xlsx" | "csv">("");

  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [groups, setGroups] = useState<ColumnGroup[]>(["identity", "volumes"]);
  const [sort, setSort] = useState<{ key: string; dir: "asc" | "desc" }>({
    key: "case_id",
    dir: "asc",
  });

  const load = useCallback(async () => {
    try {
      setLoading(true);
      setErr("");
      setData(await apiCohort());
    } catch (e: any) {
      setErr(e?.message || "Failed to load cohort");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const columns = useMemo(
    () => (data?.columns || []).filter((c) => groups.includes(c.group)),
    [data, groups]
  );

  const rows = useMemo(() => {
    const all = data?.rows || [];
    const needle = filter.trim().toLowerCase();
    const matched = needle
      ? all.filter((r) =>
          [r.case_id, r.patient_id, r.patient_name, r.status]
            .join(" ")
            .toLowerCase()
            .includes(needle)
        )
      : all;

    const { key, dir } = sort;
    const sign = dir === "asc" ? 1 : -1;
    return [...matched].sort((a, b) => {
      const x = a[key];
      const y = b[key];
      // Missing measurements sort last whichever way the column is pointing,
      // so an empty cell never displaces a real value from the top.
      if (x === null || x === undefined || x === "") return 1;
      if (y === null || y === undefined || y === "") return -1;
      if (typeof x === "number" && typeof y === "number") return (x - y) * sign;
      return String(x).localeCompare(String(y)) * sign;
    });
  }, [data, filter, sort]);

  const allShownSelected = rows.length > 0 && rows.every((r) => selected.has(r.id));

  const toggleRow = (id: number) =>
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const toggleAll = () =>
    setSelected((prev) => {
      if (allShownSelected) {
        const next = new Set(prev);
        rows.forEach((r) => next.delete(r.id));
        return next;
      }
      return new Set([...prev, ...rows.map((r) => r.id)]);
    });

  const handleExport = useCallback(
    async (format: "xlsx" | "csv") => {
      try {
        setBusy(format);
        setErr("");
        // No selection means the whole cohort — the common case, and it keeps
        // "export" from doing nothing when nobody ticked a box.
        const ids = selected.size ? [...selected] : undefined;
        const { blob, filename } = await apiCohortExport(format, ids);
        download(blob, filename);
      } catch (e: any) {
        setErr(e?.message || "Export failed");
      } finally {
        setBusy("");
      }
    },
    [selected]
  );

  const summary = data?.summary;
  const exportCount = selected.size || rows.length;

  return (
    <Box sx={{ minHeight: "100vh", bgcolor: C.bg, p: 2 }}>
      <Paper sx={{ ...panelSx, p: 2, mb: 2 }}>
        <Stack direction="row" spacing={2} alignItems="center" flexWrap="wrap" useFlexGap>
          <Button startIcon={<ArrowBackIcon />} onClick={() => navigate("/cases")} sx={{ color: C.text }}>
            Cases
          </Button>
          <Typography sx={{ color: C.text, fontWeight: 800, fontSize: 18 }}>Cohort</Typography>
          {summary && (
            <Stack direction="row" spacing={1}>
              <Chip
                size="small"
                label={`${summary.measured} analysed`}
                sx={{ bgcolor: "transparent", border: `1px solid ${C.ok}`, color: C.ok }}
              />
              {summary.unmeasured > 0 && (
                <Chip
                  size="small"
                  label={`${summary.unmeasured} without results`}
                  sx={{ bgcolor: "transparent", border: `1px solid ${C.warn}`, color: C.warn }}
                />
              )}
            </Stack>
          )}

          <Box sx={{ flex: 1 }} />

          <Tooltip title="Reload">
            <Button size="small" startIcon={<RefreshIcon />} onClick={load} sx={{ color: C.textMuted }}>
              Refresh
            </Button>
          </Tooltip>
          <Button
            size="small"
            variant="outlined"
            startIcon={<DownloadIcon />}
            disabled={!!busy || !rows.length}
            onClick={() => handleExport("csv")}
            sx={{ color: C.text, borderColor: C.border, textTransform: "none" }}
          >
            {busy === "csv" ? "Exporting…" : "CSV"}
          </Button>
          <Button
            size="small"
            variant="contained"
            startIcon={<DownloadIcon />}
            disabled={!!busy || !rows.length}
            onClick={() => handleExport("xlsx")}
            sx={{ bgcolor: C.accentDim, textTransform: "none", "&:hover": { bgcolor: C.accent } }}
          >
            {busy === "xlsx" ? "Exporting…" : `Export ${exportCount} to Excel`}
          </Button>
        </Stack>
      </Paper>

      {err && (
        <Paper sx={{ ...panelSx, p: 2, mb: 2, borderColor: C.danger }}>
          <Typography sx={{ color: C.danger, fontSize: 13, whiteSpace: "pre-wrap" }}>{err}</Typography>
        </Paper>
      )}

      {summary && (
        <Stack direction="row" spacing={1.5} sx={{ mb: 2 }} flexWrap="wrap" useFlexGap>
          {HEADLINE.map((h) => (
            <StatTile key={h.key} label={h.label} unit={h.unit} stat={summary.metrics[h.key]} />
          ))}
        </Stack>
      )}

      <Paper sx={{ ...panelSx, overflow: "hidden" }}>
        <Stack
          direction="row"
          spacing={1.5}
          alignItems="center"
          flexWrap="wrap"
          useFlexGap
          sx={{ p: 1.5, borderBottom: BORDER }}
        >
          <TextField
            size="small"
            placeholder="Filter subject, patient, status…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            sx={{
              minWidth: 260,
              "& .MuiOutlinedInput-root": { color: C.text, fontSize: 13 },
              "& fieldset": { borderColor: C.border },
            }}
          />
          <ToggleButtonGroup
            size="small"
            value={groups}
            onChange={(_, v) => v.length && setGroups(v as ColumnGroup[])}
          >
            {GROUPS.map((g) => (
              <ToggleButton key={g.key} value={g.key} sx={toggleSx}>
                {g.label}
              </ToggleButton>
            ))}
          </ToggleButtonGroup>
          <Box sx={{ flex: 1 }} />
          <Typography sx={{ color: C.textFaint, fontSize: 12 }}>
            {selected.size
              ? `${selected.size} selected of ${rows.length}`
              : `${rows.length} case${rows.length === 1 ? "" : "s"}`}
          </Typography>
        </Stack>

        {loading ? (
          <Box sx={{ p: 6, display: "grid", placeItems: "center" }}>
            <CircularProgress size={26} sx={{ color: C.accent }} />
          </Box>
        ) : (
          <TableContainer sx={{ maxHeight: "calc(100vh - 340px)" }}>
            <Table size="small" stickyHeader>
              <TableHead>
                <TableRow>
                  <TableCell padding="checkbox" sx={{ bgcolor: C.surfaceInset, borderBottom: BORDER }}>
                    <Checkbox
                      size="small"
                      checked={allShownSelected}
                      indeterminate={!allShownSelected && rows.some((r) => selected.has(r.id))}
                      onChange={toggleAll}
                      sx={{ color: C.textFaint }}
                    />
                  </TableCell>
                  {columns.map((col) => (
                    <TableCell
                      key={col.key}
                      sx={{
                        bgcolor: C.surfaceInset,
                        borderBottom: BORDER,
                        color: C.textMuted,
                        fontSize: 11,
                        fontWeight: 700,
                        whiteSpace: "nowrap",
                      }}
                    >
                      <TableSortLabel
                        active={sort.key === col.key}
                        direction={sort.key === col.key ? sort.dir : "asc"}
                        onClick={() =>
                          setSort((prev) => ({
                            key: col.key,
                            dir: prev.key === col.key && prev.dir === "asc" ? "desc" : "asc",
                          }))
                        }
                        sx={{ color: "inherit !important" }}
                      >
                        {col.label}
                      </TableSortLabel>
                    </TableCell>
                  ))}
                </TableRow>
              </TableHead>

              <TableBody>
                {rows.map((row: CohortRow) => (
                  <TableRow
                    key={row.id}
                    hover
                    onDoubleClick={() => navigate(`/analysis/${row.id}/review`)}
                    sx={{
                      cursor: "pointer",
                      opacity: row.has_metrics ? 1 : 0.55,
                      "& td": { borderBottom: BORDER, color: C.text, fontSize: 12.5 },
                    }}
                  >
                    <TableCell padding="checkbox">
                      <Checkbox
                        size="small"
                        checked={selected.has(row.id)}
                        onChange={() => toggleRow(row.id)}
                        onClick={(e) => e.stopPropagation()}
                        sx={{ color: C.textFaint }}
                      />
                    </TableCell>
                    {columns.map((col) => (
                      <TableCell
                        key={col.key}
                        align={typeof row[col.key] === "number" ? "right" : "left"}
                        sx={{
                          whiteSpace: "nowrap",
                          fontVariantNumeric: "tabular-nums",
                          fontWeight: col.key === "case_id" ? 700 : 400,
                        }}
                      >
                        {fmt(row[col.key])}
                      </TableCell>
                    ))}
                  </TableRow>
                ))}

                {!rows.length && (
                  <TableRow>
                    <TableCell colSpan={columns.length + 1} sx={{ borderBottom: "none" }}>
                      <Typography sx={{ color: C.textFaint, fontSize: 13, p: 3, textAlign: "center" }}>
                        {filter ? "No case matches that filter." : "No cases yet."}
                      </Typography>
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </TableContainer>
        )}
      </Paper>

      <Typography sx={{ color: C.textFaint, fontSize: 11, mt: 1, maxWidth: 900 }}>
        Double-click a row to open it in the review viewer. Export covers the
        selected rows, or the whole filtered list when nothing is selected.
        <br />
        Note: the 3- and 4-class volumes are percentile bands of each subject&apos;s
        own fat-fraction distribution inside the mask, so every subject splits
        20/40/40 and 20/40/20/20 by construction — the class columns are
        proportional to the total and add no between-subject information beyond
        it.
      </Typography>
    </Box>
  );
}
