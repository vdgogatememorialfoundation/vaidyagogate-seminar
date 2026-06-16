import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { StaffApp } from './portals/staff/StaffApp';

createRoot(document.getElementById('root')!).render(
    <StrictMode>
        <StaffApp />
    </StrictMode>
);
