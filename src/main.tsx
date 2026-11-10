import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';

// StrictMode is intentionally not used: the engine owns a WebGL context,
// an AudioContext and pointer lock, and should be constructed exactly once.
createRoot(document.getElementById('root')!).render(<App />);
