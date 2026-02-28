import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App';

// Track the actual visible area on iOS when the software keyboard appears.
// The layout viewport doesn't shrink, but visualViewport does.
if (window.visualViewport) {
  const updateHeight = () => {
    document.documentElement.style.setProperty(
      '--app-height',
      `${window.visualViewport!.height}px`,
    );
  };
  updateHeight();
  window.visualViewport.addEventListener('resize', updateHeight);
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
