import { createContext, useCallback, useContext, useState } from 'react';

import { AlertModal } from '@/components/ui/alert-modal';

export type AlertButtonStyle = 'default' | 'cancel' | 'destructive';

export type AlertButton = {
  text: string;
  onPress?: () => void;
  style?: AlertButtonStyle;
};

export type AlertOptions = { cancelable?: boolean };

export type ShowAlert = (
  title: string,
  message?: string,
  buttons?: AlertButton[],
  options?: AlertOptions,
) => void;

export type UseAlertReturn = { showAlert: ShowAlert };

type AlertState = {
  title: string;
  message?: string;
  buttons: AlertButton[];
  cancelable: boolean;
};

const AlertContext = createContext<ShowAlert | null>(null);

export function AlertProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<AlertState | null>(null);

  const showAlert = useCallback<ShowAlert>((title, message, buttons, options) => {
    const resolvedButtons: AlertButton[] =
      buttons && buttons.length > 0 ? buttons : [{ text: 'OK' }];
    // A second showAlert while one is open replaces it — matches RN behaviour.
    setState({
      title,
      message,
      buttons: resolvedButtons,
      cancelable: options?.cancelable ?? true,
    });
  }, []);

  function dismiss() {
    setState(null);
  }

  return (
    <AlertContext.Provider value={showAlert}>
      {children}
      {state && (
        <AlertModal
          visible
          title={state.title}
          message={state.message}
          buttons={state.buttons}
          cancelable={state.cancelable}
          onDismiss={dismiss}
        />
      )}
    </AlertContext.Provider>
  );
}

export function useAlert(): UseAlertReturn {
  const showAlert = useContext(AlertContext);
  if (!showAlert) {
    throw new Error('useAlert must be used within AlertProvider');
  }
  return { showAlert };
}
