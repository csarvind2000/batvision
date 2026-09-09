import { Routes, Route, Navigate } from "react-router-dom";
import Login from "./pages/Login";
import Signup from "./pages/Signup";
import Cases from "./pages/Cases";
import BatReviewPage from "./pages/batReview/BatReviewPage";
import Cohort from "./pages/Cohort";

export default function App() {
  return (
    <Routes>
      <Route path="/sign-in" element={<Login />} />
      <Route path="/sign-up" element={<Signup />} />
      <Route path="/" element={<Navigate to="/sign-in" replace />} />

      <Route path="/cases" element={<Cases />} />

      {/* Cohort sheet across every analysed case */}
      <Route path="/cohort" element={<Cohort />} />

      {/* Review page (Niivue) */}
      <Route path="/analysis/:caseId/review" element={<BatReviewPage />} />

      {/* Fallback */}
      <Route path="*" element={<Navigate to="/sign-in" replace />} />
    </Routes>
  );
}