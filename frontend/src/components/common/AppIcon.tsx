import { useState } from 'react';
import { isPlaceholderAppName } from '../../utils/software';

interface AppIconProps {
  url?: string;
  name: string;
  size?: 'sm' | 'md' | 'lg';
}

const sizeClasses = {
  sm: 'h-10 w-10',
  md: 'h-14 w-14',
  lg: 'h-20 w-20',
};

const surfaceClassName =
  'shrink-0 rounded-[22%] ring-1 ring-black/5 shadow-sm shadow-gray-950/10 dark:ring-white/10 dark:shadow-black/30';

export default function AppIcon({ url, name, size = 'md' }: AppIconProps) {
  const [failed, setFailed] = useState(false);

  if (!url || failed) {
    return (
      <div
        className={`${sizeClasses[size]} ${surfaceClassName} flex items-center justify-center bg-gradient-to-br from-blue-500 to-blue-700 text-white`}
        role="img"
        aria-label={name}
      >
        {isPlaceholderAppName(name) ? (
          <AppleMark className="h-[52%] w-[52%]" />
        ) : (
          <span aria-hidden="true" className="text-lg font-semibold">
            {name.charAt(0).toUpperCase()}
          </span>
        )}
      </div>
    );
  }

  return (
    <img
      src={url}
      alt={name}
      className={`${sizeClasses[size]} ${surfaceClassName} object-cover`}
      onError={() => setFailed(true)}
      draggable={false}
    />
  );
}

/**
 * The Apple mark — shown when there is no artwork and the name is only the
 * `App <id>` placeholder, where a letter would read as a meaningless "A".
 */
function AppleMark({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 384 512"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M318.7 268.7c-.2-36.7 16.4-64.4 50-84.8-18.8-26.9-47.2-41.7-84.7-44.6-35.5-2.8-74.3 20.7-88.5 20.7-15 0-49.4-19.7-76.4-19.7C63.3 141.2 4 184.8 4 273.5q0 39.3 14.4 81.2c12.8 36.7 59 126.7 107.2 125.2 25.2-.6 43-17.9 75.8-17.9 31.8 0 48.3 17.9 76.4 17.9 48.6-.7 90.4-82.5 102.6-119.3-65.2-30.7-61.7-90-61.7-91.9zm-56.6-164.2c27.3-32.4 24.8-61.9 24-72.5-24.1 1.4-52 16.4-67.9 34.9-17.5 19.8-27.8 44.3-25.6 71.9 26.1 2 49.9-11.4 69.5-34.3z" />
    </svg>
  );
}
