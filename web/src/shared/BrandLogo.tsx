import { useEffect, useState } from 'react';

export function BrandLogo({ height = 48 }: { height?: number }) {
    const [src, setSrc] = useState<string | null>(null);
    useEffect(() => {
        fetch('/api/branding/logo')
            .then((r) => r.json())
            .then((d: { url?: string }) => setSrc(d.url || null))
            .catch(() => setSrc(null));
    }, []);
    if (!src) {
        return (
            <div
                style={{
                    width: height,
                    height,
                    borderRadius: 12,
                    background: 'linear-gradient(135deg,#7c3aed,#a78bfa)',
                    display: 'grid',
                    placeItems: 'center',
                    color: '#fff',
                    fontWeight: 700,
                    fontSize: height * 0.35
                }}
            >
                V
            </div>
        );
    }
    return <img src={src} alt="VGMF" style={{ height, width: 'auto', objectFit: 'contain' }} />;
}
