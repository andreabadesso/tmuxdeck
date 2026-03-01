import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Save, X, RefreshCw, Copy, Check, AlertCircle } from 'lucide-react';
import { api } from '../api/client';
import { SettingsTabs } from '../components/SettingsTabs';

function InlineSaveButton({
  onClick,
  isPending,
  isError,
  isSuccess,
}: {
  onClick: () => void;
  isPending: boolean;
  isError?: boolean;
  isSuccess?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={isPending}
      className={`flex items-center gap-1 px-2.5 py-1.5 rounded-md text-xs text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
        isError
          ? 'bg-red-600 hover:bg-red-500'
          : isSuccess
            ? 'bg-green-600 hover:bg-green-500'
            : 'bg-blue-600 hover:bg-blue-500'
      }`}
    >
      {isError ? (
        <AlertCircle size={12} />
      ) : isSuccess ? (
        <Check size={12} />
      ) : (
        <Save size={12} />
      )}
      {isPending ? 'Saving...' : isError ? 'Error' : isSuccess ? 'Saved' : 'Save'}
    </button>
  );
}

export function TelegramSettingsPage() {
  const queryClient = useQueryClient();
  const { data: settings, error: settingsError } = useQuery({
    queryKey: ['settings'],
    queryFn: () => api.getSettings(),
  });

  const { data: chatsData } = useQuery({
    queryKey: ['telegram-chats'],
    queryFn: () => api.getTelegramChats(),
  });

  const [telegramToken, setTelegramToken] = useState('');
  const [telegramRegistrationSecret, setTelegramRegistrationSecret] = useState('');
  const [telegramTimeoutSecs, setTelegramTimeoutSecs] = useState(60);
  const [openaiApiKey, setOpenaiApiKey] = useState('');
  const [chatModel, setChatModel] = useState('gpt-4o');
  const [secretCopied, setSecretCopied] = useState(false);
  const [generateError, setGenerateError] = useState('');

  // Sync local state when settings data changes
  const [prevSettings, setPrevSettings] = useState<typeof settings>(undefined);
  if (settings && settings !== prevSettings) {
    setPrevSettings(settings);
    setTelegramToken(settings.telegramBotToken);
    setTelegramRegistrationSecret(settings.telegramRegistrationSecret ?? '');
    setTelegramTimeoutSecs(settings.telegramNotificationTimeoutSecs ?? 60);
    setOpenaiApiKey(settings.openaiApiKey ?? '');
    setChatModel(settings.chatModel ?? 'gpt-4o');
  }

  const invalidateSettings = () => queryClient.invalidateQueries({ queryKey: ['settings'] });
  const invalidateChats = () => queryClient.invalidateQueries({ queryKey: ['telegram-chats'] });

  const saveTokenMutation = useMutation({
    mutationFn: () => api.updateSettings({ telegramBotToken: telegramToken }),
    onSuccess: invalidateSettings,
  });

  const saveTimeoutMutation = useMutation({
    mutationFn: () => api.updateSettings({ telegramNotificationTimeoutSecs: telegramTimeoutSecs }),
    onSuccess: invalidateSettings,
  });

  const saveOpenaiKeyMutation = useMutation({
    mutationFn: () => api.updateSettings({ openaiApiKey }),
    onSuccess: invalidateSettings,
  });

  const saveChatModelMutation = useMutation({
    mutationFn: () => api.updateSettings({ chatModel }),
    onSuccess: invalidateSettings,
  });

  const toggleAudioDebugMutation = useMutation({
    mutationFn: (enabled: boolean) => api.updateSettings({ audioDebugLog: enabled }),
    onSuccess: invalidateSettings,
  });

  const removeChatMutation = useMutation({
    mutationFn: (chatId: number) => api.removeTelegramChat(chatId),
    onSuccess: invalidateChats,
  });

  const fallbackCopy = (text: string) => {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
  };

  const chats = chatsData?.chats ?? [];

  return (
    <div className="px-6 py-8">
      <SettingsTabs />
      <div className="max-w-2xl">
        <h1 className="text-xl font-semibold text-gray-100 mb-8">Telegram Bot</h1>

        {settingsError && (
          <div className="mb-4 px-3 py-2 rounded-lg bg-red-900/30 border border-red-800 text-sm text-red-400">
            Failed to load settings: {settingsError.message}
          </div>
        )}

        <div className="space-y-6">
          {/* Bot Token */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="block text-sm text-gray-400">Bot Token</label>
              <InlineSaveButton
                onClick={() => saveTokenMutation.mutate()}
                isPending={saveTokenMutation.isPending}
                isError={saveTokenMutation.isError}
                isSuccess={saveTokenMutation.isSuccess}
              />
            </div>
            <input
              type="password"
              value={telegramToken}
              onChange={(e) => {
                setTelegramToken(e.target.value);
                saveTokenMutation.reset();
              }}
              placeholder="123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11"
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 outline-none focus:border-blue-500 font-mono"
            />
            {saveTokenMutation.isError && (
              <p className="text-xs text-red-400 mt-1">
                {saveTokenMutation.error.message}
              </p>
            )}
            <p className="text-xs text-gray-600 mt-1">
              Get a token from @BotFather on Telegram
            </p>
          </div>

          {/* Registration Secret */}
          <div>
            <label className="block text-sm text-gray-400 mb-1">Registration Secret</label>
            <div className="flex items-center gap-2">
              <input
                readOnly
                value={telegramRegistrationSecret}
                placeholder="Click Generate to create a secret"
                className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 outline-none font-mono"
              />
              <button
                onClick={() => {
                  const text = telegramRegistrationSecret;
                  if (navigator.clipboard?.writeText) {
                    navigator.clipboard.writeText(text).catch(() => {
                      fallbackCopy(text);
                    });
                  } else {
                    fallbackCopy(text);
                  }
                  setSecretCopied(true);
                  setTimeout(() => setSecretCopied(false), 2000);
                }}
                disabled={!telegramRegistrationSecret}
                className="flex items-center gap-1 px-2 py-1.5 rounded-md text-xs text-gray-500 hover:text-gray-200 disabled:opacity-30 transition-colors"
                title="Copy to clipboard"
              >
                {secretCopied ? (
                  <>
                    <Check size={12} className="text-green-400" />
                    <span className="text-green-400">Copied!</span>
                  </>
                ) : (
                  <>
                    <Copy size={12} />
                    <span>Copy</span>
                  </>
                )}
              </button>
              <button
                onClick={async () => {
                  setGenerateError('');
                  try {
                    const res = await fetch('/api/v1/settings/generate-secret', { method: 'POST' });
                    if (!res.ok) {
                      const text = await res.text().catch(() => res.statusText);
                      setGenerateError(`Failed (${res.status}): ${text}`);
                      return;
                    }
                    const data = await res.json();
                    setTelegramRegistrationSecret(data.secret);
                    invalidateSettings();
                  } catch (err) {
                    setGenerateError(err instanceof Error ? err.message : 'Request failed');
                  }
                }}
                className="flex items-center gap-1 px-3 py-2 rounded-lg text-xs bg-gray-700 text-gray-300 hover:bg-gray-600 transition-colors"
              >
                <RefreshCw size={12} />
                Generate
              </button>
            </div>
            {generateError && (
              <p className="text-xs text-red-400 mt-1">{generateError}</p>
            )}
            <p className="text-xs text-gray-600 mt-1">
              Send <code className="text-gray-500">/start &lt;secret&gt;</code> to your bot on Telegram to register for notifications
            </p>
          </div>

          {/* Connected Users */}
          <div>
            <label className="block text-sm text-gray-400 mb-2">Connected Users</label>
            {chats.length === 0 ? (
              <p className="text-xs text-gray-600">
                No users connected yet. Generate a secret above and send <code className="text-gray-500">/start &lt;secret&gt;</code> to your bot on Telegram.
              </p>
            ) : (
              <div className="space-y-1">
                {chats.map((chat) => (
                  <div key={chat.chatId} className="flex items-center justify-between bg-gray-800 border border-gray-700 rounded-lg px-3 py-2">
                    <div className="flex items-center gap-2">
                      {(chat.firstName || chat.username) && (
                        <span className="text-sm text-gray-200">
                          {chat.firstName ?? chat.username}
                        </span>
                      )}
                      {chat.username && (
                        <span className="text-xs text-gray-500">@{chat.username}</span>
                      )}
                      <span className="text-xs text-gray-600 font-mono">{chat.chatId}</span>
                    </div>
                    <button
                      onClick={() => removeChatMutation.mutate(chat.chatId)}
                      disabled={removeChatMutation.isPending}
                      className="p-1 text-gray-500 hover:text-red-400 transition-colors"
                      title="Remove user"
                    >
                      <X size={14} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Notification Timeout */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="block text-sm text-gray-400">Notification Timeout (seconds)</label>
              <InlineSaveButton
                onClick={() => saveTimeoutMutation.mutate()}
                isPending={saveTimeoutMutation.isPending}
                isError={saveTimeoutMutation.isError}
                isSuccess={saveTimeoutMutation.isSuccess}
              />
            </div>
            <input
              type="number"
              min={0}
              max={600}
              value={telegramTimeoutSecs}
              onChange={(e) => {
                setTelegramTimeoutSecs(Math.max(0, Math.min(600, Number(e.target.value) || 0)));
                saveTimeoutMutation.reset();
              }}
              className="w-24 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 outline-none focus:border-blue-500"
            />
            {saveTimeoutMutation.isError && (
              <p className="text-xs text-red-400 mt-1">
                {saveTimeoutMutation.error.message}
              </p>
            )}
            <p className="text-xs text-gray-600 mt-1">
              Time to wait before sending notification to Telegram (if no browser responds)
            </p>
          </div>

          {/* AI Agent Section */}
          <div className="border-t border-gray-800 pt-6">
            <h2 className="text-base font-medium text-gray-300 mb-4">AI Voice Agent</h2>
            <div className="space-y-4">
              {/* OpenAI API Key */}
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="block text-sm text-gray-400">OpenAI API Key</label>
                  <InlineSaveButton
                    onClick={() => saveOpenaiKeyMutation.mutate()}
                    isPending={saveOpenaiKeyMutation.isPending}
                    isError={saveOpenaiKeyMutation.isError}
                    isSuccess={saveOpenaiKeyMutation.isSuccess}
                  />
                </div>
                <input
                  type="password"
                  value={openaiApiKey}
                  onChange={(e) => {
                    setOpenaiApiKey(e.target.value);
                    saveOpenaiKeyMutation.reset();
                  }}
                  placeholder="sk-..."
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 outline-none focus:border-blue-500 font-mono"
                />
                {saveOpenaiKeyMutation.isError && (
                  <p className="text-xs text-red-400 mt-1">
                    {saveOpenaiKeyMutation.error.message}
                  </p>
                )}
                <p className="text-xs text-gray-600 mt-1">
                  Required for /chat voice agent (STT, LLM, TTS)
                </p>
              </div>

              {/* Chat Model */}
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="block text-sm text-gray-400">Chat Model</label>
                  <InlineSaveButton
                    onClick={() => saveChatModelMutation.mutate()}
                    isPending={saveChatModelMutation.isPending}
                    isError={saveChatModelMutation.isError}
                    isSuccess={saveChatModelMutation.isSuccess}
                  />
                </div>
                <input
                  type="text"
                  value={chatModel}
                  onChange={(e) => {
                    setChatModel(e.target.value);
                    saveChatModelMutation.reset();
                  }}
                  placeholder="gpt-4o"
                  className="w-48 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 outline-none focus:border-blue-500 font-mono"
                />
              </div>
            </div>
          </div>

          {/* Audio Debug Log */}
          <div>
            <div className="flex items-center justify-between">
              <div>
                <label className="block text-sm text-gray-400">Audio Debug Log</label>
                <p className="text-xs text-gray-600 mt-0.5">
                  Log transcriptions of voice messages to the debug log
                </p>
              </div>
              <button
                onClick={() => toggleAudioDebugMutation.mutate(!settings?.audioDebugLog)}
                disabled={toggleAudioDebugMutation.isPending}
                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                  settings?.audioDebugLog ? 'bg-blue-600' : 'bg-gray-700'
                } disabled:opacity-50`}
              >
                <span
                  className={`inline-block h-4 w-4 rounded-full bg-white transition-transform ${
                    settings?.audioDebugLog ? 'translate-x-6' : 'translate-x-1'
                  }`}
                />
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
