import { createRoot } from 'react-dom/client';
import '../../src/ui/page.css';
import { Popup } from './Popup';

createRoot(document.getElementById('root')!).render(<Popup />);
