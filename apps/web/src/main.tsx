import React from 'react';
import ReactDOM from 'react-dom/client';
import { ClerkProvider } from '@clerk/clerk-react';
import { BrowserRouter } from 'react-router-dom';
import { DevAuthProvider } from './auth/DevAuthContext';
import { App } from './App';
import './index.css';

const clerkPubKey = import.meta.env['VITE_CLERK_PUBLISHABLE_KEY'] as string;

// Swap favicon based on environment
{
  const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (link) {
    if (import.meta.env.PROD) {
      link.href = '/favicon-prod.svg';
    } else if (import.meta.env['VITE_BETA_MODE'] === 'true') {
      link.href = '/favicon-beta.svg';
    }
  }
}

const root = document.getElementById('root');
if (!root) throw new Error('Root element not found');

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <ClerkProvider publishableKey={clerkPubKey}>
      <DevAuthProvider>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </DevAuthProvider>
    </ClerkProvider>
  </React.StrictMode>,
);
