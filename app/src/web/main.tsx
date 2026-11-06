import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { HtmlPreviewProvider } from './HtmlPreviewPool';
import { TooltipLayer } from './TooltipLayer';
import './styles.css';

createRoot(document.getElementById('root')!).render(<StrictMode><HtmlPreviewProvider><App /><TooltipLayer /></HtmlPreviewProvider></StrictMode>);
