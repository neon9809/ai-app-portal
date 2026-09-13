import { Navigate, Route, Routes } from 'react-router-dom';
import { PortalLayout } from './layouts/PortalLayout';
import { HomePage } from './pages/Home';
import { LoginPage } from './pages/Login';
import { RegisterPage } from './pages/Register';
import { ForgotPage } from './pages/Forgot';
import { MfaSetupPage } from './pages/MfaSetup';
import { ForceChangePasswordPage } from './pages/ForceChangePassword';

export default function App() {
  return (
    <Routes>
      <Route element={<PortalLayout />}>
        <Route path="/" element={<HomePage />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />
        <Route path="/forgot" element={<ForgotPage />} />
        <Route path="/initialize" element={<ForceChangePasswordPage />} />
        <Route path="/mfa-setup" element={<MfaSetupPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
