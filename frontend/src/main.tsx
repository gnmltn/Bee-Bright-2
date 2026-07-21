import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';

// Log environment for debugging
console.log('Frontend Environment:', {
  apiUrl: import.meta.env.VITE_API_URL,
  mode: import.meta.env.MODE,
  dev: import.meta.env.DEV,
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);