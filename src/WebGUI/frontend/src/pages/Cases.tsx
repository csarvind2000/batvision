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
  Chip,
  LinearProgress,
  Collapse,
  Divider,
  MenuItem,
  Select,
  InputLabel,
  FormControl,
  Paper,
  Checkbox,
} from "@mui/material";
import CloudUploadIcon from "@mui/icons-material/CloudUpload";
import RefreshIcon from "@mui/icons-material/Refresh";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import FolderIcon from "@mui/icons-material/Folder";
import CloseIcon from "@mui/icons-material/Close";

import {
  apiListCases,
  apiUploadOneCase,
  apiTriggerProcessing,
  apiGetCaseStatus,
  apiDeleteCases,
} from "../api/client";

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

function statusChip(status: CaseStatus) {
  switch (status) {
    case "PROCESSING":
      return <Chip size="small" label="Processing" color="warning" variant="outlined" />;
    case "FAILED":
      return <Chip size="small" label="Processing failed" color="error" variant="outlined" />;
    case "READY":
      return <Chip size="small" label="Ready to review" color="success" variant="outlined" />;
  }
}

function formatDate(iso?: string) {
  if (!iso) return "-";
  const d = new Date(iso);
  return d.toLocaleString();
}

export default function Cases() {
  const navigate = useNavigate();

  const [cases, setCases] = React.useState<(CaseItem & { expanded?: boolean })[]>([]);
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
        expanded: false,
      }))
    );
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

  const toggleExpand = (id: string) => {
    setCases((prev) => prev.map((c) => (c.id === id ? { ...c, expanded: !c.expanded } : c)));
  };

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

  return (
    <Box
      sx={{
        minHeight: "100vh",
        bgcolor: "#0f1115",
        p: 2,
        "& .MuiTypography-root": { color: "#eaeef6" },
      }}
    >
      {/* Top Bar */}
      <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 2 }}>
        <Stack direction="row" spacing={1.5} alignItems="center">
          <FolderIcon sx={{ color: "#a78bfa" }} />
          <Typography variant="h6" sx={{ fontWeight: 700 }}>
            BAT Cases
          </Typography>
        </Stack>

        <Stack direction="row" spacing={1}>
          <IconButton onClick={refresh} sx={{ color: "#cbd5e1" }}>
            <RefreshIcon />
          </IconButton>

          <Button
            variant="contained"
            startIcon={<CloudUploadIcon />}
            onClick={() => setUploadOpen(true)}
            sx={{
              bgcolor: "#7c3aed",
              "&:hover": { bgcolor: "#6d28d9" },
              borderRadius: 2,
              textTransform: "none",
            }}
          >
            Upload Case(s)
          </Button>
        </Stack>
      </Stack>

      {/* Filters */}
      <Stack direction="row" spacing={1.5} alignItems="center" sx={{ mb: 2 }}>
        <TextField
          size="small"
          placeholder="Search by Subject ID"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          sx={{
            width: 320,
            "& .MuiInputBase-root": { bgcolor: "#111827", color: "#eaeef6" },
            "& input::placeholder": { color: "#9ca3af" },
          }}
        />

        <FormControl size="small" sx={{ minWidth: 180 }}>
          <InputLabel sx={{ color: "#9ca3af" }}>Study Status</InputLabel>
          <Select
            label="Study Status"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as any)}
            sx={{
              bgcolor: "#111827",
              color: "#eaeef6",
              ".MuiSvgIcon-root": { color: "#9ca3af" },
            }}
          >
            <MenuItem value="">All</MenuItem>
            <MenuItem value="PROCESSING">Processing</MenuItem>
            <MenuItem value="FAILED">Processing failed</MenuItem>
            <MenuItem value="READY">Ready to review</MenuItem>
          </Select>
        </FormControl>

        <Box sx={{ flex: 1 }} />

        <Button
          variant="outlined"
          disabled={selectedIds.length === 0}
          sx={{ borderColor: "#374151", color: "#eaeef6", textTransform: "none" }}
          onClick={() => console.log("Export selected", selectedIds)}
        >
          Export
        </Button>

        <Button
          variant="outlined"
          disabled={selectedIds.length === 0}
          sx={{ borderColor: "#374151", color: "#eaeef6", textTransform: "none" }}
          onClick={openDeleteDialog}
        >
          Delete
        </Button>
      </Stack>

      {/* List */}
      <Stack spacing={1.5}>
        {filtered.map((c) => (
          <Paper
            key={c.id}
            elevation={0}
            sx={{
              bgcolor: "#111827",
              border: "1px solid #1f2937",
              borderRadius: 2,
              overflow: "hidden",
            }}
          >
            <Box sx={{ p: 1.5 }}>
              <Stack direction="row" alignItems="center" spacing={1.5}>
                <Checkbox
                  checked={!!selected[c.id]}
                  onChange={(e) => setSelected((prev) => ({ ...prev, [c.id]: e.target.checked }))}
                  sx={{ color: "#374151", "&.Mui-checked": { color: "#a78bfa" } }}
                />

                <Box sx={{ minWidth: 260 }}>
                  <Typography sx={{ fontWeight: 800, color: "#ffffff" }}>
                    {c.subject_id || c.case_id || c.case_name || "(missing subject_id)"}
                  </Typography>

                  <Typography variant="caption" sx={{ color: "#9ca3af" }}>
                    Uploaded: {formatDate(c.created_at)}
                  </Typography>
                </Box>

                <Box sx={{ flex: 1 }} />

                {statusChip(c.status)}

                <IconButton
                  onClick={() => toggleExpand(c.id)}
                  sx={{
                    color: "#cbd5e1",
                    transform: c.expanded ? "rotate(180deg)" : "none",
                  }}
                >
                  <ExpandMoreIcon />
                </IconButton>
              </Stack>

              {c.status === "PROCESSING" && (
                <Box sx={{ mt: 1 }}>
                  <LinearProgress
                    variant={typeof c.progress === "number" ? "determinate" : "indeterminate"}
                    value={c.progress ?? 0}
                    sx={{
                      height: 6,
                      borderRadius: 999,
                      bgcolor: "#0b1220",
                      "& .MuiLinearProgress-bar": { bgcolor: "#a78bfa" },
                    }}
                  />
                  <Typography variant="caption" sx={{ color: "#9ca3af" }}>
                    {c.status_message ?? "Processing…"}{" "}
                    {typeof c.progress === "number" ? `(${c.progress}%)` : ""}
                  </Typography>
                </Box>
              )}

              {c.status === "FAILED" && c.status_message && (
                <Typography variant="caption" sx={{ color: "#f87171", display: "block", mt: 0.8 }}>
                  {c.status_message}
                </Typography>
              )}
            </Box>

            <Collapse in={!!c.expanded}>
              <Divider sx={{ borderColor: "#1f2937" }} />
              <Box sx={{ p: 1.5, bgcolor: "#0b1220" }}>
                <Stack direction="row" spacing={1} sx={{ mt: 2 }}>
                  <Button
                    variant="contained"
                    disabled={c.status !== "READY"}
                    sx={{
                      bgcolor: "#7c3aed",
                      "&:hover": { bgcolor: "#6d28d9" },
                      textTransform: "none",
                    }}
                    onClick={() => navigate(`/analysis/${c.id}/review`)}
                  >
                    Review
                  </Button>

                  <Button
                    variant="outlined"
                    sx={{ borderColor: "#374151", color: "#eaeef6", textTransform: "none" }}
                    onClick={async () => {
                      await apiTriggerProcessing([c.id]);
                      await refresh();
                    }}
                  >
                    Re-run AI
                  </Button>
                </Stack>
              </Box>
            </Collapse>
          </Paper>
        ))}
      </Stack>

      {/* Delete Confirmation */}
      <Dialog open={deleteOpen} onClose={closeDeleteDialog} maxWidth="md" fullWidth>
        <DialogTitle sx={{ bgcolor: "#0b1220", color: "#eaeef6", fontWeight: 800 }}>
          Delete Confirmation
        </DialogTitle>

        <DialogContent sx={{ bgcolor: "#0b1220", color: "#eaeef6", pt: 2 }}>
          <Typography sx={{ color: "#cbd5e1", mb: 1 }}>
            Are you sure you want to delete <b>{selectedIds.length}</b> case(s)?
          </Typography>

          <Typography sx={{ color: "#f87171", fontWeight: 700 }}>
            This action cannot be undone
          </Typography>

          {deleteError && <Typography sx={{ color: "#f87171", mt: 1 }}>{deleteError}</Typography>}
        </DialogContent>

        <DialogActions sx={{ bgcolor: "#0b1220", p: 2 }}>
          <Button
            variant="outlined"
            onClick={closeDeleteDialog}
            disabled={deleteBusy}
            sx={{
              flex: 1,
              borderColor: "#cbd5e1",
              color: "#eaeef6",
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
              bgcolor: "#7c3aed",
              "&:hover": { bgcolor: "#6d28d9" },
              textTransform: "none",
              borderRadius: 2,
              height: 46,
            }}
          >
            {deleteBusy ? "Deleting..." : "Confirm Delete"}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Upload Dialog */}
      <Dialog open={uploadOpen} onClose={() => (uploadBusy ? null : setUploadOpen(false))} maxWidth="md" fullWidth>
        <DialogContent sx={{ bgcolor: "#0b1220", color: "#eaeef6", position: "relative", p: 3 }}>
          <IconButton
            onClick={() => setUploadOpen(false)}
            disabled={uploadBusy}
            sx={{ position: "absolute", right: 10, top: 10, color: "#cbd5e1" }}
          >
            <CloseIcon />
          </IconButton>

          <Typography variant="h6" sx={{ fontWeight: 800 }}>
            Upload BAT Case(s)
          </Typography>

          <Typography variant="body2" sx={{ color: "#9ca3af", mb: 2 }}>
            Naming rule:
            <br />
            <b>&lt;SUBJECT&gt;_F_0000.nii.gz</b> = FAT
            <br />
            <b>&lt;SUBJECT&gt;_FF_0001.nii.gz</b> = FAT FRACTION
          </Typography>

          {uploadError && <Typography sx={{ color: "#f87171", mb: 2 }}>{uploadError}</Typography>}
          {uploadStatusText && <Typography sx={{ color: "#cbd5e1", mb: 2 }}>{uploadStatusText}</Typography>}

          <Box
            sx={{
              border: "2px dashed #334155",
              borderRadius: 2,
              p: 5,
              textAlign: "center",
              bgcolor: "#0f172a",
              opacity: uploadBusy ? 0.6 : 1,
            }}
          >
            <CloudUploadIcon sx={{ fontSize: 44, color: "#a78bfa" }} />
            <Typography sx={{ mt: 1, mb: 2 }}>
              Select a folder. Subfolder names will become case names.
            </Typography>

            <Stack direction="row" justifyContent="center" spacing={1.5}>
              <Button
                variant="outlined"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploadBusy}
                sx={{ borderColor: "#475569", color: "#eaeef6", textTransform: "none" }}
              >
                Browse File(s)
              </Button>

              <Button
                variant="outlined"
                onClick={() => folderInputRef.current?.click()}
                disabled={uploadBusy}
                sx={{ borderColor: "#475569", color: "#eaeef6", textTransform: "none" }}
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