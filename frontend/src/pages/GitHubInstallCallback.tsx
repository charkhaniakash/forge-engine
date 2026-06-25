import React, { useEffect, useState } from 'react';

export const GitHubInstallCallback: React.FC = () => {
  const [status, setStatus] = useState<'loading' | 'success' | 'error'>('loading');
  const [message, setMessage] = useState('');

  useEffect(() => {
    // Check if we have a state parameter in the URL
    const urlParams = new URLSearchParams(window.location.search);
    const state = urlParams.get('state');

    if (!state) {
      setStatus('error');
      setMessage('Missing installation state parameter');
      return;
    }

    // The callback is handled by the backend which returns HTML
    // For this implementation, we'll just show a loading state
    // and let the backend handle the actual response
    setStatus('success');
    setMessage('Installation received. The platform will finish linking your repositories shortly.');
  }, []);

  return (
    <div style={{
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      display: 'flex',
      justifyContent: 'center',
      alignItems: 'center',
      height: '100vh',
      margin: 0,
      backgroundColor: '#f6f8fa',
    }}>
      <div style={{
        textAlign: 'center',
        backgroundColor: 'white',
        padding: '2rem',
        borderRadius: '8px',
        boxShadow: '0 2px 8px rgba(0,0,0,0.1)',
        maxWidth: '400px',
      }}>
        {status === 'loading' && (
          <>
            <div style={{ fontSize: '4rem', marginBottom: '1rem' }}>⟳</div>
            <h1 style={{ color: '#24292f', marginBottom: '1rem' }}>Processing Installation</h1>
            <p style={{ color: '#24292f', lineHeight: '1.5' }}>Please wait while we process your GitHub App installation...</p>
          </>
        )}

        {status === 'success' && (
          <>
            <div style={{ fontSize: '4rem', marginBottom: '1rem' }}>✅</div>
            <h1 style={{ color: '#1a7f37', marginBottom: '1rem' }}>Installation Received</h1>
            <p style={{ color: '#24292f', lineHeight: '1.5' }}>{message}</p>
            <p style={{ color: '#24292f', lineHeight: '1.5' }}>You can close this window and return to the application.</p>
          </>
        )}

        {status === 'error' && (
          <>
            <div style={{ fontSize: '4rem', marginBottom: '1rem' }}>❌</div>
            <h1 style={{ color: '#cf222e', marginBottom: '1rem' }}>Installation Failed</h1>
            <p style={{ color: '#24292f', lineHeight: '1.5' }}>{message}</p>
            <p style={{ color: '#24292f', lineHeight: '1.5' }}>Please try again or contact support.</p>
          </>
        )}
      </div>
    </div>
  );
};
