import { apiFetch } from "../api/http";

const data = await apiFetch(`/cases/${caseId}/bat-review/`, { method: "GET" });