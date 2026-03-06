interface ErrorAlertProps {
  message: string;
  className?: string;
}

export function ErrorAlert({ message, className = '' }: ErrorAlertProps) {
  return (
    <div className={`flex items-center gap-2 rounded-lg bg-red-500/10 border border-red-500/30 px-3 py-2 ${className}`}>
      <svg
        className="w-4 h-4 text-red-400 shrink-0"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        strokeWidth={2}
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z"
        />
      </svg>
      <p className="text-red-400 text-sm">Something went wrong</p>
    </div>
  );
}
