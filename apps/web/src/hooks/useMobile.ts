import { useState, useEffect } from 'react';

const MOBILE_UA_REGEX =
  /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i;

function detectMobileDevice(): boolean {
  return MOBILE_UA_REGEX.test(navigator.userAgent);
}

export function useMobile(): boolean {
  const [viewportNarrow, setViewportNarrow] = useState<boolean>(
    () => window.matchMedia('(max-width: 768px)').matches,
  );

  useEffect(() => {
    const mq = window.matchMedia('(max-width: 768px)');
    const handler = (e: MediaQueryListEvent): void => setViewportNarrow(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  return detectMobileDevice() || viewportNarrow;
}
