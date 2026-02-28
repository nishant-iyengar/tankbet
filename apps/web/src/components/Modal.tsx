interface ModalProps {
  children: React.ReactNode;
  onClose?: () => void;
  maxWidth?: string;
}

export function Modal({ children, onClose, maxWidth = 'max-w-md' }: ModalProps): React.JSX.Element {
  return (
    <div
      className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4"
      onClick={onClose}
    >
      <div
        className={`bg-slate-800 border border-slate-700 rounded-xl w-full ${maxWidth}`}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}
