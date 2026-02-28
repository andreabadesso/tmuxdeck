import { Outlet, useLocation } from 'react-router-dom';
import { Sidebar } from './Sidebar';

export function Layout() {
  const location = useLocation();
  const isMainPage = location.pathname === '/';

  return (
    <div className="flex bg-gray-950 text-gray-100" style={{ height: 'var(--app-height, 100dvh)' }}>
      {isMainPage ? (
        <Outlet />
      ) : (
        <>
          <Sidebar />
          <main className="flex-1 overflow-auto">
            <Outlet />
          </main>
        </>
      )}
    </div>
  );
}
