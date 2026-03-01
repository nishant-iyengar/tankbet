import { useState } from 'react';
import { loadStripe } from '@stripe/stripe-js';
import { useAppUser } from '../auth/useAppAuth';
import { useApi } from '../hooks/useApi';
import { Modal } from './Modal';

interface BankSetupModalProps {
  onSuccess: () => void;
  onClose: () => void;
}

export function BankSetupModal({ onSuccess, onClose }: BankSetupModalProps): React.JSX.Element {
  const { user } = useAppUser();
  const { post } = useApi();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function handleConnect(): Promise<void> {
    setLoading(true);
    setError('');
    try {
      const { clientSecret, publishableKey } = await post<{
        clientSecret: string;
        publishableKey: string;
      }>('/api/payments/setup-bank', {});

      const stripe = await loadStripe(publishableKey);
      if (!stripe) throw new Error('Stripe failed to load');

      const email = user?.primaryEmailAddress?.emailAddress ?? '';
      const name = user?.fullName ?? user?.username ?? '';

      const { setupIntent: collected, error: collectError } = await stripe.collectBankAccountForSetup({
        clientSecret,
        params: {
          payment_method_type: 'us_bank_account',
          payment_method_data: {
            billing_details: { name, email },
          },
        },
      });

      if (collectError) throw new Error(collectError.message);
      if (!collected) throw new Error('Bank collection did not return a setup intent');

      const { setupIntent: confirmed, error: confirmError } =
        await stripe.confirmUsBankAccountSetup(clientSecret);

      if (confirmError) throw new Error(confirmError.message);
      if (!confirmed) throw new Error('Failed to confirm setup intent');

      await post('/api/payments/save-bank', { setupIntentId: confirmed.id });
      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to connect bank account');
    } finally {
      setLoading(false);
    }
  }

  return (
    <Modal onClose={onClose}>
      <div className="p-6">
        <h2 className="text-lg font-bold text-white mb-2">Connect Bank Account</h2>
        <p className="text-sm text-slate-400 mb-5">
          A bank account is required to play. Your bet is charged after each game and the
          donation is sent to the winning charity automatically.
        </p>

        {error && <p className="text-red-400 text-sm mb-4">{error}</p>}

        <button
          onClick={() => void handleConnect()}
          disabled={loading}
          className="w-full bg-cyan-400 text-slate-900 font-semibold py-2.5 rounded-lg text-sm hover:bg-cyan-300 transition-colors disabled:opacity-40 disabled:pointer-events-none mb-2"
        >
          {loading ? 'Connecting…' : 'Connect via Stripe'}
        </button>

        <button
          onClick={onClose}
          className="w-full border border-slate-600 text-slate-400 py-2.5 rounded-lg text-sm font-medium hover:border-slate-500 hover:text-slate-300 transition-colors"
        >
          Cancel
        </button>
      </div>
    </Modal>
  );
}
