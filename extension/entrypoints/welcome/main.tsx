import { createRoot } from 'react-dom/client';
import '../../src/ui/page.css';
import './welcome.css';
import { Welcome } from './Welcome';

createRoot(document.getElementById('root')!).render(<Welcome />);
