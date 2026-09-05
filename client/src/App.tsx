import { useEffect, useRef, useState } from 'react';
import {
  Link,
  NavLink,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useSearchParams,
} from 'react-router-dom';
import { api } from './api';
import { Icon, ToastHost } from './components';
import { HomePage } from './pages/Home';
import { TitlePage } from './pages/Title';
import { PersonPage } from './pages/Person';
import { LibraryPage } from './pages/Library';
import { SettingsPage } from './pages/Settings';

function NavSearch() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [value, setValue] = useState(params.get('q') ?? '');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setValue(params.get('q') ?? '');
  }, [params]);

  // "/" focuses search from anywhere, the way it works everywhere else.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = target && /input|textarea/i.test(target.tagName);
      if (event.key === '/' && !typing) {
        event.preventDefault();
        inputRef.current?.focus();
      }
      if (event.key === 'Escape') inputRef.current?.blur();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <form
      className="search"
      onSubmit={(event) => {
        event.preventDefault();
        const query = value.trim();
        if (query) navigate(`/?q=${encodeURIComponent(query)}`);
      }}
    >
      <span className="search-icon">{Icon.search(16)}</span>
      <input
        ref={inputRef}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        placeholder="Search a film, show, or actor…"
        aria-label="Search films, shows and actors"
      />
    </form>
  );
}

/**
 * Whether we were launched from the home screen rather than a browser tab. iOS
 * has set `navigator.standalone` since long before it understood the
 * display-mode query, so take either signal.
 */
function isStandalone(): boolean {
  return (
    (navigator as { standalone?: boolean }).standalone === true ||
    window.matchMedia('(display-mode: standalone)').matches
  );
}

/**
 * Launched from the home screen there is no browser back button, and a face in
 * a cast grid is several taps deep.
 */
function BackButton() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [standalone] = useState(isStandalone);
  if (!standalone || pathname === '/') return null;

  return (
    <button className="nav-back" onClick={() => navigate(-1)} aria-label="Go back">
      {Icon.back(19)}
    </button>
  );
}

export default function App() {
  const [unresolved, setUnresolved] = useState(0);

  useEffect(() => {
    const load = () =>
      api
        .stats()
        .then((stats) => setUnresolved(stats.unresolved))
        .catch(() => {});
    load();
    const timer = window.setInterval(load, 20_000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <ToastHost>
      <div className="shell">
        <nav className="nav">
          <div className="wrap">
            <BackButton />
            <Link to="/" className="brand">
              <span className="brand-mark">◎</span>
              Actor Explorer
            </Link>
            <NavSearch />
            <div className="nav-links">
              <NavLink to="/" end className="nav-link" aria-label="Home">
                {Icon.home(16)}
              </NavLink>
              <NavLink to="/library" className="nav-link" aria-label="Library">
                {Icon.library(16)}
                <span className="label">Library</span>
                {unresolved > 0 && <span className="nav-badge">{unresolved}</span>}
              </NavLink>
              <NavLink to="/settings" className="nav-link" aria-label="Settings">
                {Icon.settings(16)}
                <span className="label">Settings</span>
              </NavLink>
            </div>
          </div>
        </nav>

        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/title/:mediaType/:id" element={<TitlePage />} />
          <Route path="/person/:id" element={<PersonPage />} />
          <Route path="/library" element={<LibraryPage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Routes>
      </div>
    </ToastHost>
  );
}
