// NotificationContainer — connects Redux + WS sync; renders Bell + Panel.
// Mounted once in AppShell so notifications are globally available.
import { useState, useEffect, useRef } from 'react';
import { useAppDispatch } from '~/hooks/useAppDispatch';
import { fetchNotificationsThunk } from '../slices/notificationSlice';
import { useNotificationSync } from '../hooks/useNotificationSync';
import { useNotificationNavigate } from '../hooks/useNotificationNavigate';
import NotificationBell from '../components/NotificationBell';
import NotificationPanel from '../components/NotificationPanel';

export default function NotificationContainer() {
  const dispatch = useAppDispatch();
  const [panelOpen, setPanelOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Fetch initial notifications on mount
  useEffect(() => {
    dispatch(fetchNotificationsThunk());
  }, [dispatch]);

  // Subscribe to WS notification_created events
  useNotificationSync();

  // Close panel on outside click
  useEffect(() => {
    function handleOutsideClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setPanelOpen(false);
      }
    }
    if (panelOpen) {
      document.addEventListener('mousedown', handleOutsideClick);
    }
    return () => document.removeEventListener('mousedown', handleOutsideClick);
  }, [panelOpen]);

  const handleNavigate = useNotificationNavigate();

  return (
    <div ref={containerRef} className="relative">
      <NotificationBell onClick={() => setPanelOpen((prev) => !prev)} />
      {panelOpen && (
        <NotificationPanel onClose={() => setPanelOpen(false)} onNavigate={handleNavigate} />
      )}
    </div>
  );
}
