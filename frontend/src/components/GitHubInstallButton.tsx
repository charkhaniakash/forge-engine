import React, { useState } from 'react';

interface GitHubInstallButtonProps {
  token: string;
  onError?: (error: string) => void;
}

export const GitHubInstallButton: React.FC<GitHubInstallButtonProps> = ({ token, onError }) => {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleInstall = async () => {
    setLoading(true);
    setError(null);

    try {
      const response = await fetch('http://localhost:8080/v1/github/install/url', {
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      });

      const data = await response.json();

      if (!response.ok) {
        const errorMessage = data.error || 'Failed to generate install URL';
        setError(errorMessage);
        onError?.(errorMessage);
        return;
      }

      // Open GitHub install URL in new tab
      window.open(data.install_url, '_blank');
    } catch (err: any) {
      const errorMessage = err.message || 'Failed to generate install URL';
      setError(errorMessage);
      onError?.(errorMessage);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <button
        onClick={handleInstall}
        disabled={loading}
        style={{
          backgroundColor: '#24292f',
          color: 'white',
          padding: '0.5rem 1rem',
          borderRadius: '6px',
          border: 'none',
          cursor: loading ? 'not-allowed' : 'pointer',
          fontSize: '14px',
          fontWeight: '600',
          display: 'flex',
          alignItems: 'center',
          gap: '0.5rem',
        }}
      >
        {loading ? (
          <>
            <span style={{ animation: 'spin 1s linear infinite' }}>⟳</span>
            Loading...
          </>
        ) : (
          <>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/>
            </svg>
            Install GitHub App
          </>
        )}
      </button>

      {error && (
        <div style={{ color: '#cf222e', marginTop: '0.5rem', fontSize: '14px' }}>
          {error}
        </div>
      )}

      <style>{`
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
};
