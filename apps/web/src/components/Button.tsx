import type { ButtonHTMLAttributes } from 'react';

type ButtonVariant = 'primary' | 'ghost' | 'danger';
type ButtonSize = 'sm' | 'md' | 'lg';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

const variantClasses: Record<ButtonVariant, string> = {
  primary: 'bg-cyan-400 text-slate-900 font-semibold hover:bg-cyan-300 disabled:opacity-40 disabled:pointer-events-none',
  ghost:   'border border-slate-600 text-slate-300 hover:border-slate-400 hover:text-white disabled:opacity-40 disabled:pointer-events-none',
  danger:  'bg-red-500/20 border border-red-500/50 text-red-400 hover:bg-red-500/30 disabled:opacity-40 disabled:pointer-events-none',
};

const sizeClasses: Record<ButtonSize, string> = {
  sm: 'px-3 py-1.5 text-xs rounded-md',
  md: 'px-4 py-2.5 text-sm rounded-lg',
  lg: 'px-5 py-3 text-sm rounded-lg',
};

export function Button({
  variant = 'primary',
  size = 'md',
  className = '',
  children,
  ...props
}: ButtonProps): React.JSX.Element {
  return (
    <button
      className={`font-medium transition-colors ${variantClasses[variant]} ${sizeClasses[size]} ${className}`}
      {...props}
    >
      {children}
    </button>
  );
}
