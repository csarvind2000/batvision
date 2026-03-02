import * as React from "react";
import Snackbar from "@mui/material/Snackbar";
import Alert from "@mui/material/Alert";

type Severity = "error" | "warning" | "info" | "success";
type ShowAlert = (message: React.ReactNode, severity?: Severity) => void;

const AlertContext = React.createContext<ShowAlert | null>(null);

export function useAlert(): ShowAlert {
  const ctx = React.useContext(AlertContext);
  if (!ctx) throw new Error("useAlert must be used within AlertProvider");
  return ctx;
}

export function AlertProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = React.useState(false);
  const [message, setMessage] = React.useState<React.ReactNode>("");
  const [severity, setSeverity] = React.useState<Severity>("info");

  const showAlert: ShowAlert = (msg, sev = "info") => {
    setMessage(msg);
    setSeverity(sev);
    setOpen(true);
  };

  return (
    <AlertContext.Provider value={showAlert}>
      {children}
      <Snackbar
        open={open}
        onClose={() => setOpen(false)}
        anchorOrigin={{ vertical: "top", horizontal: "center" }}
      >
        <Alert
          severity={severity}
          onClose={() => setOpen(false)}
          variant="filled"
          sx={{ width: "100%", whiteSpace: "normal", wordBreak: "break-word" }}
        >
          {message}
        </Alert>
      </Snackbar>
    </AlertContext.Provider>
  );
}
