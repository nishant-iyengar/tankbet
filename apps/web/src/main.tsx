import React from 'react';
import ReactDOM from 'react-dom/client';
import { ClerkProvider } from '@clerk/clerk-react';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import './index.css';

const clerkPubKey = import.meta.env['VITE_CLERK_PUBLISHABLE_KEY'] as string;

// Swap favicon to green variant in beta mode
if (import.meta.env['VITE_BETA_MODE'] === 'true') {
  const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (link) link.href = '/favicon-beta.svg';
}

const root = document.getElementById('root');
if (!root) throw new Error('Root element not found');

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <ClerkProvider publishableKey={clerkPubKey}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </ClerkProvider>
  </React.StrictMode>,
);
