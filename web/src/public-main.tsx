import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { PublicApp } from './portals/public/PublicApp';

createRoot(document.getElementById('root')!).render(
    <StrictMode>
        <PublicApp />
    </StrictMode>
);
