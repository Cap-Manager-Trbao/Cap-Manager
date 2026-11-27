import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Input } from 'antd';
import { MessageSquareText, RotateCcw, Save, Sparkles } from 'lucide-react';
import {
  TELEGRAM_TEMPLATE_KEYS,
  TELEGRAM_TEMPLATE_META,
  formatTelegramPhotoCaption,
  formatTelegramTestMessage,
  getDefaultBotLabel,
  getDefaultTelegramTemplates,
  sanitizeTelegramTemplates,
} from '../utils/telegramMessages.js';
import { getTodayDateString } from '../utils/storage.js';

function decodeHtmlEntities(str) {
  return String(str || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"');
}

function renderInlineTelegramLine(line, lineKey) {
  const tokenRegex = /(<b>[\s\S]*?<\/b>|<code>[\s\S]*?<\/code>|<a\s+href="[^"]*">[\s\S]*?<\/a>)/g;
  const parts = String(line || '').split(tokenRegex);
  return parts.map((part, idx) => {
    const key = `${lineKey}-${idx}`;
    if (part.startsWith('<b>') && part.endsWith('</b>')) {
      return (
        <strong key={key} className="font-semibold text-white">
          {decodeHtmlEntities(part.slice(3, -4))}
        </strong>
      );
    }
    if (part.startsWith('<code>') && part.endsWith('</code>')) {
      return (
        <code
          key={key}
          className="px-1 py-0.5 rounded bg-slate-700/90 text-sky-200 font-mono text-[11px]"
        >
          {decodeHtmlEntities(part.slice(6, -7))}
        </code>
      );
    }
    const linkMatch = part.match(/^<a\s+href="([^"]*)">([\s\S]*?)<\/a>$/);
    if (linkMatch) {
      return (
        <span key={key} className="text-sky-300 underline underline-offset-2">
          {decodeHtmlEntities(linkMatch[2])}
        </span>
      );
    }
    return <React.Fragment key={key}>{decodeHtmlEntities(part)}</React.Fragment>;
  });
}

function TelegramPreviewBubble({ botTitle, htmlText }) {
  const lines = String(htmlText || '').split('\n');
  return (
    <div className="rounded-lg bg-[#17212B] text-slate-100 p-3.5 border border-slate-700/80 shadow-xs text-[12.5px] leading-relaxed font-sans">
      <div className="text-[11px] font-semibold text-sky-300 mb-1.5">{botTitle}</div>
      <div className="space-y-1 break-words">
        {lines.map((line, i) =>
          line.trim() === '' ? (
            <div key={i} className="h-1.5" />
          ) : (
            <div key={i}>{renderInlineTelegramLine(line, i)}</div>
          )
        )}
      </div>
    </div>
  );
}

export default function TelegramMessageCustomizer({
  activeGroup,
  canEdit,
  settings,
  botUsername = '',
  onUpdateSettings,
  onNotify,
}) {
  const [selectedType, setSelectedType] = useState('capPublish');
  const [draftTemplates, setDraftTemplates] = useState(() =>
    sanitizeTelegramTemplates(settings?.telegramTemplates)
  );
  const [saving, setSaving] = useState(false);
  const textAreaRef = useRef(null);

  const savedTemplates = useMemo(
    () => sanitizeTelegramTemplates(settings?.telegramTemplates),
    [settings?.telegramTemplates]
  );

  useEffect(() => {
    setDraftTemplates(sanitizeTelegramTemplates(settings?.telegramTemplates));
  }, [activeGroup?.id, settings?.telegramTemplates]);

  const groupId = activeGroup?.id || '';
  const botLabel = getDefaultBotLabel(groupId);
  const defaultTemplates = useMemo(() => getDefaultTelegramTemplates(groupId), [groupId]);

  const meta = TELEGRAM_TEMPLATE_META[selectedType] || TELEGRAM_TEMPLATE_META.capPublish;
  const savedVal = savedTemplates[selectedType] || '';
  const draftVal = draftTemplates[selectedType] || '';
  const defaultTemplateText = defaultTemplates[selectedType] || '';
  const editorValue = draftVal || defaultTemplateText;

  const isSavedCustom = Boolean(savedVal);
  const normalizedDraftStorageVal =
    editorValue.trim() === defaultTemplateText.trim() ? '' : editorValue.trim();
  const isDirty = normalizedDraftStorageVal !== savedVal;

  const handleTextChange = (e) => {
    const nextRaw = String(e.target.value || '').slice(0, 800);
    const nextNormalized =
      nextRaw.trim() === defaultTemplateText.trim() ? '' : nextRaw;
    setDraftTemplates((prev) => ({
      ...prev,
      [selectedType]: nextNormalized,
    }));
  };

  const handleInsertVariable = (token) => {
    if (!canEdit) return;
    const current = editorValue;
    const nativeEl = textAreaRef.current?.resizableTextArea?.textArea;
    if (nativeEl && typeof nativeEl.selectionStart === 'number') {
      const start = nativeEl.selectionStart;
      const end = nativeEl.selectionEnd ?? start;
      const before = current.slice(0, start);
      const after = current.slice(end);
      const leadSpace = before.length > 0 && !/[\s\n]$/.test(before) ? ' ' : '';
      const trailSpace = after.length > 0 && !/^[\s\n.,!?:;)]/.test(after) ? ' ' : '';
      const insertChunk = `${leadSpace}${token}${trailSpace}`;
      const next = `${before}${insertChunk}${after}`.slice(0, 800);
      const nextNormalized =
        next.trim() === defaultTemplateText.trim() ? '' : next;
      setDraftTemplates((prev) => ({
        ...prev,
        [selectedType]: nextNormalized,
      }));
      requestAnimationFrame(() => {
        nativeEl.focus();
        const cursor = Math.min(next.length, start + insertChunk.length);
        nativeEl.setSelectionRange(cursor, cursor);
      });
      return;
    }

    const appended = `${current}${current.endsWith(' ') || current.endsWith('\n') || !current ? '' : ' '}${token}`.slice(
      0,
      800
    );
    setDraftTemplates((prev) => ({
      ...prev,
      [selectedType]: appended,
    }));
  };

  const handleSaveTemplate = async () => {
    if (!canEdit || !onUpdateSettings) return;
    const sanitizedNext = sanitizeTelegramTemplates({
      ...savedTemplates,
      [selectedType]: normalizedDraftStorageVal,
    });
    setSaving(true);
    try {
      await onUpdateSettings({
        ...settings,
        telegramTemplates: sanitizedNext,
      });
      onNotify?.(
        'success',
        normalizedDraftStorageVal
          ? `Đã lưu mẫu tin nhắn "${meta.label}" cho ${activeGroup?.name || 'nhóm'}.`
          : `Đã lưu dùng mẫu mặc định cho "${meta.label}".`
      );
    } finally {
      setSaving(false);
    }
  };

  const handleResetDefault = async () => {
    if (!canEdit || !onUpdateSettings) return;
    const nextDrafts = sanitizeTelegramTemplates({
      ...draftTemplates,
      [selectedType]: '',
    });
    setDraftTemplates(nextDrafts);
    if (savedVal) {
      const nextSaved = sanitizeTelegramTemplates({
        ...savedTemplates,
        [selectedType]: '',
      });
      setSaving(true);
      try {
        await onUpdateSettings({
          ...settings,
          telegramTemplates: nextSaved,
        });
        onNotify?.('success', `Đã khôi phục mẫu mặc định cho "${meta.label}".`);
      } finally {
        setSaving(false);
      }
    }
  };

  const previewHtml = useMemo(() => {
    const groupName = activeGroup?.name || 'Nhóm 1';
    const todayStr = getTodayDateString();
    const activeMembers = Array.isArray(activeGroup?.members) ? activeGroup.members : [];
    const sampleAppLink = `https://cap-manager.app/?groupId=${activeGroup?.id || 'group-1'}&date=${todayStr}`;
    const customTemplateToPreview = normalizedDraftStorageVal;

    if (selectedType === 'capPublish') {
      return formatTelegramPhotoCaption({
        groupId,
        groupName,
        dateStr: todayStr,
        stats: { assignedTotalCap: 49, assignedTotalPoints: 1285 },
        isUpdate: false,
        appLink: sampleAppLink,
        customTemplate: customTemplateToPreview,
      });
    }

    if (selectedType === 'capUpdate') {
      return formatTelegramPhotoCaption({
        groupId,
        groupName,
        dateStr: todayStr,
        stats: { assignedTotalCap: 49, assignedTotalPoints: 1285 },
        diffs: [
          { memberName: activeMembers[0]?.name || 'Trung Bảo', delta: 1, offerCode: '21997905' },
          { memberName: activeMembers[1]?.name || 'Uyên', delta: -1, offerCode: '21997905' },
        ],
        isUpdate: true,
        appLink: sampleAppLink,
        customTemplate: customTemplateToPreview,
      });
    }

    return formatTelegramTestMessage({
      groupId,
      groupName,
      dateStr: todayStr,
      appLink: sampleAppLink,
      customTemplate: customTemplateToPreview,
    });
  }, [activeGroup, groupId, normalizedDraftStorageVal, selectedType]);

  const botTitle = botUsername
    ? `${botLabel} (@${botUsername})`
    : `${botLabel} ${activeGroup?.name || 'Nhóm'}`;

  return (
    <div className="border-t border-slate-200/80 pt-4 mt-1 flex flex-col gap-3.5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-slate-900 m-0 flex items-center gap-2">
            <MessageSquareText className="w-4 h-4 text-[#2563EB]" aria-hidden="true" />
            Tùy chỉnh nội dung tin nhắn của Bot
          </h3>
          <p className="text-xs text-slate-500 mt-0.5 mb-0">
            Chỉnh lời nhắn riêng của {botLabel} cho {activeGroup?.name || 'nhóm'} theo từng sự kiện. Chèn biến tự động hoặc dùng <code className="font-mono text-slate-700">**in đậm**</code>.
          </p>
        </div>

        <div
          role="tablist"
          aria-label="Chọn loại tin nhắn Bot Telegram"
          className="inline-flex flex-wrap gap-1.5 bg-slate-100 p-1 rounded-lg border border-slate-200/80"
        >
          {TELEGRAM_TEMPLATE_KEYS.filter((key) => key !== 'shiftReminder').map((key) => {
            const itemMeta = TELEGRAM_TEMPLATE_META[key];
            const isActive = selectedType === key;
            const hasCustom = Boolean(savedTemplates[key]);
            return (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={isActive}
                onClick={() => setSelectedType(key)}
                className={`px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors flex items-center gap-1.5 cursor-pointer border ${
                  isActive
                    ? 'bg-white text-slate-900 border-slate-200 shadow-xs'
                    : 'bg-transparent text-slate-600 border-transparent hover:text-slate-900'
                }`}
              >
                <span>{itemMeta.label}</span>
                {hasCustom && (
                  <span
                    className="w-1.5 h-1.5 rounded-full bg-[#2563EB]"
                    title="Đã tùy chỉnh riêng"
                    aria-hidden="true"
                  />
                )}
              </button>
            );
          })}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Editor Column */}
        <div className="flex flex-col gap-2.5 p-4 rounded-lg bg-slate-50 border border-slate-200">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <label
              htmlFor="telegram-template-editor"
              className="text-xs font-semibold text-slate-800"
            >
              Mẫu tin nhắn: {meta.label}
            </label>
            <span
              className={`text-[11px] font-medium ${
                isSavedCustom || Boolean(normalizedDraftStorageVal)
                  ? 'text-[#2563EB]'
                  : 'text-slate-500'
              }`}
            >
              {normalizedDraftStorageVal
                ? isDirty
                  ? 'Đang chỉnh sửa (chưa lưu)'
                  : 'Đã lưu mẫu tùy chỉnh'
                : 'Đang dùng mẫu mặc định'}
            </span>
          </div>

          <p className="text-[11px] text-slate-500 m-0">{meta.description}</p>

          <Input.TextArea
            ref={textAreaRef}
            id="telegram-template-editor"
            disabled={!canEdit}
            value={editorValue}
            onChange={handleTextChange}
            rows={5}
            maxLength={800}
            showCount
            placeholder={defaultTemplateText}
            className="text-xs leading-relaxed"
          />

          <div className="flex flex-col gap-1.5 pt-1">
            <span className="text-[11px] font-medium text-slate-600">
              Bấm để chèn nhanh biến tự động:
            </span>
            <div className="flex flex-wrap gap-1.5">
              {meta.variables.map((v) => (
                <button
                  key={v.token}
                  type="button"
                  disabled={!canEdit}
                  onClick={() => handleInsertVariable(v.token)}
                  title={`Chèn ${v.token} (${v.label})`}
                  className="px-2 py-1 rounded bg-white border border-slate-200 hover:border-[#2563EB] hover:text-[#2563EB] disabled:opacity-50 disabled:cursor-not-allowed text-[11px] text-slate-700 cursor-pointer transition-colors"
                >
                  <code className="font-mono font-semibold text-[#2563EB]">{v.token}</code>{' '}
                  <span className="text-slate-500">{v.label}</span>
                </button>
              ))}
            </div>
          </div>

          {canEdit && (
            <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-slate-200/80 mt-1">
              <Button
                size="small"
                icon={<RotateCcw className="w-3.5 h-3.5" />}
                disabled={!isSavedCustom && !normalizedDraftStorageVal}
                loading={saving}
                onClick={handleResetDefault}
              >
                Khôi phục mặc định
              </Button>
              <Button
                size="small"
                type="primary"
                icon={<Save className="w-3.5 h-3.5" />}
                disabled={!isDirty}
                loading={saving}
                onClick={handleSaveTemplate}
              >
                Lưu mẫu tin nhắn
              </Button>
            </div>
          )}
        </div>

        {/* Live Preview Column */}
        <div className="flex flex-col justify-between gap-2.5 p-4 rounded-lg bg-slate-50 border border-slate-200">
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-semibold text-slate-800 flex items-center gap-1.5">
                <Sparkles className="w-3.5 h-3.5 text-[#2563EB]" aria-hidden="true" />
                Xem trước tin nhắn trên Telegram
              </span>
              <span className="text-[11px] text-slate-500 font-tabular">
                {selectedType === 'capPublish' || selectedType === 'capUpdate'
                  ? `${previewHtml.length}/1020 ký tự`
                  : `${previewHtml.length} ký tự`}
              </span>
            </div>

            <TelegramPreviewBubble botTitle={botTitle} htmlText={previewHtml} />
          </div>

          <div className="text-[11px] text-slate-500 border-t border-slate-200/80 pt-2">
            {meta.maxPreviewHint} Nếu không chèn sẵn <code className="font-mono text-slate-700">{'{link}'}</code>, hệ thống tự gắn đường dẫn mở CAP Manager ở cuối tin nhắn.
          </div>
        </div>
      </div>
    </div>
  );
}
