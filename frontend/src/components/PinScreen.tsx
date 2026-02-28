import { useState, useRef, useEffect, useCallback } from 'react';
import { loginWithPin, setupPin } from '../api/httpClient';
import type { LoginError } from '../api/httpClient';

interface PinScreenProps {
  mode: 'setup' | 'login';
  onSuccess: () => void;
  locked?: boolean;
}

export function PinScreen({ mode, onSuccess, locked: initialLocked }: PinScreenProps) {
  const [pin, setPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [step, setStep] = useState<'enter' | 'confirm'>(mode === 'setup' ? 'enter' : 'enter');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [remainingAttempts, setRemainingAttempts] = useState<number | null>(null);
  const [retryAfter, setRetryAfter] = useState(0);
  const [isLocked, setIsLocked] = useState(initialLocked ?? false);
  const inputRef = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Sync external locked prop
  useEffect(() => {
    if (initialLocked !== undefined) setIsLocked(initialLocked);
  }, [initialLocked]);

  // Countdown timer for retryAfter
  useEffect(() => {
    if (retryAfter <= 0) {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
      return;
    }
    timerRef.current = setInterval(() => {
      setRetryAfter((prev) => {
        const next = prev - 1;
        if (next <= 0) {
          if (timerRef.current) clearInterval(timerRef.current);
          timerRef.current = null;
          return 0;
        }
        return next;
      });
    }, 1000);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [retryAfter > 0]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!isLocked && retryAfter <= 0) {
      inputRef.current?.focus();
    }
  }, [step, isLocked, retryAfter]);

  // Auto-submit when 4 digits are entered
  useEffect(() => {
    const value = step === 'confirm' ? confirmPin : pin;
    if (value.length === 4 && !loading && !isLocked && retryAfter <= 0) {
      formRef.current?.requestSubmit();
    }
  }, [pin, confirmPin, step, loading, isLocked, retryAfter]);

  const handleLoginError = useCallback((err: unknown) => {
    const loginErr = err as LoginError;
    if (loginErr.locked) {
      setIsLocked(true);
      setError('');
      setRetryAfter(0);
      return;
    }
    if (loginErr.retryAfter && loginErr.retryAfter > 0) {
      setRetryAfter(Math.ceil(loginErr.retryAfter));
    }
    if (loginErr.remainingAttempts !== undefined) {
      setRemainingAttempts(loginErr.remainingAttempts);
    }
    setError(loginErr.message || 'Login failed');
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (mode === 'setup') {
      if (step === 'enter') {
        if (pin.length !== 4 || !/^\d{4}$/.test(pin)) {
          setError('PIN must be exactly 4 digits');
          return;
        }
        setStep('confirm');
        setConfirmPin('');
        return;
      }
      // confirm step
      if (confirmPin !== pin) {
        setError('PINs do not match');
        setConfirmPin('');
        return;
      }
      setLoading(true);
      try {
        await setupPin(pin);
        onSuccess();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Setup failed');
      } finally {
        setLoading(false);
      }
    } else {
      // login mode
      if (pin.length !== 4 || !/^\d{4}$/.test(pin)) {
        setError('PIN must be exactly 4 digits');
        return;
      }
      setLoading(true);
      try {
        await loginWithPin(pin);
        onSuccess();
      } catch (err) {
        handleLoginError(err);
        setPin('');
      } finally {
        setLoading(false);
      }
    }
  };

  const currentValue = step === 'confirm' ? confirmPin : pin;
  const setCurrentValue = step === 'confirm' ? setConfirmPin : setPin;
  const isDisabled = isLocked || retryAfter > 0;

  const title = mode === 'setup'
    ? (step === 'enter' ? 'Create a PIN' : 'Confirm your PIN')
    : isLocked
      ? 'Locked'
      : 'Enter PIN';

  const subtitle = mode === 'setup'
    ? (step === 'enter' ? 'Set a 4-digit PIN to secure access' : 'Re-enter your PIN to confirm')
    : isLocked
      ? ''
      : 'Enter your 4-digit PIN to continue';

  return (
    <div className="fixed inset-0 bg-[#0a0a0a] flex items-center justify-center z-50">
      <form ref={formRef} onSubmit={handleSubmit} className="w-full max-w-xs space-y-6 px-4">
        <div className="text-center space-y-2">
          <h1 className="text-xl font-semibold text-gray-100">{title}</h1>
          {subtitle && <p className="text-sm text-gray-500">{subtitle}</p>}
        </div>

        {isLocked ? (
          <div className="text-center space-y-3">
            <div className="w-12 h-12 mx-auto rounded-full bg-red-900/30 flex items-center justify-center">
              <svg className="w-6 h-6 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
              </svg>
            </div>
            <p className="text-sm text-red-400">
              Too many failed attempts. Login is locked.
            </p>
            <p className="text-xs text-gray-500">
              Use the Telegram <code className="text-gray-400">/unlock</code> command to restore access.
            </p>
          </div>
        ) : (
          <>
            <div
              className={`relative flex justify-center gap-3 ${isDisabled ? 'opacity-50' : 'cursor-text'}`}
              onClick={() => !isDisabled && inputRef.current?.focus()}
            >
              {[0, 1, 2, 3].map((i) => (
                <div
                  key={i}
                  className={`w-12 h-14 rounded-lg border-2 flex items-center justify-center text-2xl font-mono transition-colors ${
                    i < currentValue.length
                      ? 'border-blue-500 bg-gray-800 text-gray-100'
                      : 'border-gray-700 bg-gray-900 text-gray-600'
                  }`}
                >
                  {i < currentValue.length ? '\u2022' : ''}
                </div>
              ))}
              <input
                ref={inputRef}
                type="tel"
                inputMode="numeric"
                pattern="\d*"
                maxLength={4}
                value={currentValue}
                disabled={isDisabled}
                onChange={(e) => {
                  const v = e.target.value.replace(/\D/g, '').slice(0, 4);
                  setCurrentValue(v);
                  setError('');
                }}
                className="absolute inset-0 opacity-0 cursor-text"
                autoFocus
                autoComplete="off"
              />
            </div>

            {retryAfter > 0 && (
              <p className="text-center text-sm text-yellow-400">
                Too many attempts. Try again in {retryAfter}s
              </p>
            )}

            {error && retryAfter <= 0 && (
              <p className="text-center text-sm text-red-400">{error}</p>
            )}

            {remainingAttempts !== null && remainingAttempts <= 3 && remainingAttempts > 0 && retryAfter <= 0 && !isLocked && (
              <p className="text-center text-xs text-yellow-500">
                {remainingAttempts} attempt{remainingAttempts !== 1 ? 's' : ''} remaining
              </p>
            )}

            <button
              type="submit"
              disabled={currentValue.length !== 4 || loading || isDisabled}
              className="w-full py-2.5 rounded-lg text-sm font-medium bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {loading
                ? 'Please wait...'
                : retryAfter > 0
                  ? `Wait ${retryAfter}s`
                  : mode === 'setup'
                    ? (step === 'enter' ? 'Next' : 'Set PIN')
                    : 'Unlock'
              }
            </button>
          </>
        )}

        {mode === 'setup' && step === 'confirm' && !isLocked && (
          <button
            type="button"
            onClick={() => {
              setStep('enter');
              setPin('');
              setConfirmPin('');
              setError('');
            }}
            className="w-full text-center text-xs text-gray-500 hover:text-gray-400"
          >
            Start over
          </button>
        )}
      </form>
    </div>
  );
}
