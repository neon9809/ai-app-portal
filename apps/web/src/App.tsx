import { Navigate, Route, Routes } from 'react-router-dom';
import { PortalLayout } from './layouts/PortalLayout';
import { HomePage } from './pages/Home';
import { AppFramePage } from './pages/AppFrame';
import { LoginPage } from './pages/Login';
import { RegisterPage } from './pages/Register';
import { ForgotPage } from './pages/Forgot';
import { MfaSetupPage } from './pages/MfaSetup';
import { ForceChangePasswordPage } from './pages/ForceChangePassword';
import { AccountPage } from './pages/Account';
import { AdminPage } from './pages/Admin';
import { RunToolPage } from './pages/RunTool';
import { GuidePage } from './pages/Guide';

export default function App() {
  return (
    <Routes>
      <Route element={<PortalLayout />}>
        <Route path="/" element={<HomePage />} />
        <Route path="/open/:id" element={<AppFramePage />} />
        <Route path="/run/:id" element={<RunToolPage />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />
        <Route path="/forgot" element={<ForgotPage />} />
        <Route path="/initialize" element={<ForceChangePasswordPage />} />
        <Route path="/mfa-setup" element={<MfaSetupPage />} />
        <Route path="/account" element={<AccountPage />} />
        <Route path="/admin" element={<AdminPage />} />
        <Route path="/guide" element={<GuidePage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
