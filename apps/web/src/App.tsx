import { Navigate, Route, Routes } from 'react-router-dom';
import { PortalLayout } from './layouts/PortalLayout';
import { HomePage } from './pages/Home';
import { LoginPage } from './pages/Login';

export default function App() {
  return (
    <Routes>
      <Route element={<PortalLayout />}>
        <Route path="/" element={<HomePage />} />
        <Route path="/login" element={<LoginPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
