import * as React from "react";
import {
  Box,
  Card,
  CardContent,
  Typography,
  TextField,
  Button,
  Alert,
  Stack,
  Divider,
} from "@mui/material";
import { useNavigate } from "react-router-dom";
import http from "../api/http";

export default function Signup() {
  const navigate = useNavigate();

  const [username, setUsername] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");

  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");

  const onSignup = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");

    try {
      await http.post("/api/auth/register/", {
        username: username.trim(),
        email: email.trim(),
        password,
      });

      navigate("/sign-in");
    } catch (err: any) {
      const msg =
        err?.response?.data?.detail ||
        (typeof err?.response?.data === "string"
          ? err.response.data
          : JSON.stringify(err?.response?.data || err?.message || "Signup failed"));

      setError(msg);
    } finally {
      setBusy(false);
    }
  };

  const fieldSx = {
    "& .MuiInputBase-root": {
      bgcolor: "#0f172a",
      color: "white",
    },
    "& .MuiOutlinedInput-notchedOutline": {
      borderColor: "#1f2937",
    },
    "&:hover .MuiOutlinedInput-notchedOutline": {
      borderColor: "#374151",
    },
    "& .MuiOutlinedInput-root.Mui-focused .MuiOutlinedInput-notchedOutline": {
      borderColor: "#8b5cf6",
    },
    /* Fix browser autofill */
    "& input:-webkit-autofill": {
      WebkitBoxShadow: "0 0 0 1000px #0f172a inset",
      WebkitTextFillColor: "white",
      caretColor: "white",
      borderRadius: "inherit",
    },
  } as const;

  const labelProps = {
    shrink: true,
    sx: {
      color: "#9ca3af",
      "&.Mui-focused": { color: "#c4b5fd" },
    },
  } as const;

  return (
    <Box
      sx={{
        minHeight: "100vh",
        background: "linear-gradient(180deg, #0b1220 0%, #060b16 100%)",
        display: "flex",
        flexDirection: "column",
      }}
    >
      {/* Header */}
      <Box
        sx={{
          height: 70,
          borderBottom: "1px solid rgba(255,255,255,0.05)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Typography
          variant="h6"
          sx={{
            color: "#c4b5fd",
            fontWeight: 800,
            letterSpacing: 2,
          }}
        >
          BATVision
        </Typography>
      </Box>

      {/* Center Content */}
      <Box sx={{ flex: 1, display: "grid", placeItems: "center", px: 2 }}>
        <Card
          sx={{
            width: 440,
            borderRadius: 4,
            background: "rgba(17, 24, 39, 0.85)",
            backdropFilter: "blur(20px)",
            border: "1px solid rgba(255,255,255,0.05)",
            color: "white",
          }}
        >
          <CardContent sx={{ p: 4 }}>
            <Typography variant="h5" fontWeight={700}>
              Sign up
            </Typography>

            <Typography sx={{ mt: 1, mb: 3, color: "#9ca3af" }}>
              Create an account to access BAT analysis cases
            </Typography>

            {error && (
              <Alert severity="error" sx={{ mb: 2 }}>
                {error}
              </Alert>
            )}

            <Box component="form" onSubmit={onSignup}>
              <Stack spacing={2}>
                <TextField
                  label="Username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  fullWidth
                  autoComplete="username"
                  InputLabelProps={labelProps}
                  sx={fieldSx}
                />

                <TextField
                  label="Email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  fullWidth
                  autoComplete="email"
                  InputLabelProps={labelProps}
                  sx={fieldSx}
                />

                <TextField
                  label="Password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  fullWidth
                  autoComplete="new-password"
                  InputLabelProps={labelProps}
                  sx={fieldSx}
                />

                <Button
                  type="submit"
                  disabled={busy}
                  sx={{
                    height: 45,
                    borderRadius: 2,
                    fontWeight: 600,
                    textTransform: "none",
                    color: "white",
                    background: "linear-gradient(90deg, #7c3aed 0%, #a855f7 100%)",
                    "&:hover": {
                      background: "linear-gradient(90deg, #6d28d9 0%, #9333ea 100%)",
                    },
                  }}
                >
                  {busy ? "Creating..." : "Create Account"}
                </Button>

                <Divider sx={{ borderColor: "#1f2937" }} />

                <Stack direction="row" spacing={1} justifyContent="center" alignItems="center">
                  <Typography sx={{ color: "#9ca3af" }}>
                    Already have an account?
                  </Typography>
                  <Button
                    variant="text"
                    onClick={() => navigate("/sign-in")}
                    disabled={busy}
                    sx={{ color: "#a78bfa", textTransform: "none" }}
                  >
                    Sign in
                  </Button>
                </Stack>
              </Stack>
            </Box>
          </CardContent>
        </Card>
      </Box>

      {/* Footer */}
      <Box
        sx={{
          height: 60,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "#6b7280",
          fontSize: 13,
        }}
      >
        BATVision Research Edition v1.0.0
      </Box>
    </Box>
  );
}