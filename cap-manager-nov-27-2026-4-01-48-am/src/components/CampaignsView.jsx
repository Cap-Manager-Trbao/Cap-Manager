import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Switch,
  Table,
} from 'antd';
import {
  Plus,
  Pencil,
  Trash2,
  Upload,
  Download,
  Copy,
  Search,
  Clock,
  KeyRound,
  ClipboardPaste,
  Sparkles,
  ImagePlus,
  X,
  Eye,
  EyeOff,
} from 'lucide-react';
import {
  downloadCampaignTemplateExcel,
  parseCampaignsFromExcelBuffer,
} from '../utils/excelService.js';
import { sortOffersByPointsDesc } from '../utils/capAlgorithm.js';
import {
  findDuplicateOfferCodes,
  mergeOffersByCode,
  parseQuickPastedOffers,
} from '../utils/offerParser.js';
import { normalizeAiParsedOffers } from '../utils/aiHelpers.js';
import { aiParseOffers } from '../utils/aiClient.js';
import { createId } from '../utils/storage.js';

export default function CampaignsView({
  activeGroup,
  canEdit,
  onOpenLogin,
  onRequestReauth,
  campaigns,
  members,
  history,
  onAddCampaign,
  onUpdateCampaign,
  onDeleteCampaign,
  onReplaceCampaigns,
  onNotify,
}) {
  const [searchText, setSearchText] = useState('');
  const [modalOpen, setModalOpen] = useState(false);
  const [editingOffer, setEditingOffer] = useState(null);
  const [copyModalOpen, setCopyModalOpen] = useState(false);
  const [selectedHistoryId, setSelectedHistoryId] = useState(null);
  const [pasteModalOpen, setPasteModalOpen] = useState(false);
  const [pasteText, setPasteText] = useState('');
  const [aiModalOpen, setAiModalOpen] = useState(false);
  const [aiInputText, setAiInputText] = useState('');
  const [aiImageDataUrl, setAiImageDataUrl] = useState('');
  const [aiImageMime, setAiImageMime] = useState('image/png');
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState('');
  const [aiSummary, setAiSummary] = useState('');
  const [aiExtractedOffers, setAiExtractedOffers] = useState([]);
  const [aiSelectedRowIds, setAiSelectedRowIds] = useState([]);
  const [selectedRowKeys, setSelectedRowKeys] = useState([]);
  const [bulkHourModalOpen, setBulkHourModalOpen] = useState(false);
  const [bulkCapHour, setBulkCapHour] = useState('10h');
  const [form] = Form.useForm();
  const fileInputRef = useRef(null);
  const aiImageInputRef = useRef(null);

  useEffect(() => {
    const validIds = new Set(campaigns.map((c) => c.id));
    setSelectedRowKeys((prev) => prev.filter((id) => validIds.has(id)));
  }, [campaigns]);

  const duplicateCodes = useMemo(() => findDuplicateOfferCodes(campaigns), [campaigns]);

  const pastePreview = useMemo(() => {
    if (!pasteText.trim()) return null;
    return parseQuickPastedOffers(pasteText, campaigns);
  }, [pasteText, campaigns]);

  const eligibilityTypeValue = Form.useWatch('eligibilityType', form);

  const sortedOffers = sortOffersByPointsDesc(campaigns);
  const filteredOffers = sortedOffers.filter((c) => {
    const q = searchText.trim().toLowerCase();
    if (!q) return true;
    return (
      String(c.code || '').toLowerCase().includes(q) ||
      String(c.name || '').toLowerCase().includes(q) ||
      String(c.capHour || '').toLowerCase().includes(q) ||
      String(c.timeWindow || '').toLowerCase().includes(q)
    );
  });

  const totalCap = filteredOffers
    .filter((c) => !c.hidden)
    .reduce((s, c) => s + (Number(c.totalCap) || 0), 0);
  const totalPoints = filteredOffers
    .filter((c) => !c.hidden)
    .reduce((s, c) => s + (Number(c.totalCap) || 0) * (Number(c.pointsPerCap) || 0), 0);
  const activeOfferCount = campaigns.filter((c) => !c.hidden).length;
  const hiddenOfferCount = campaigns.length - activeOfferCount;

  const openAddModal = () => {
    setEditingOffer(null);
    form.resetFields();
    form.setFieldsValue({
      code: '',
      name: '',
      capHour: '10h',
      totalCap: 5,
      pointsPerCap: 25,
      timeWindow: '10h (Cả ngày)',
      eligibilityType: 'all',
      eligibleMemberIds: [],
      condition: 'Tất cả thành viên',
      note: '',
      hidden: false,
    });
    setModalOpen(true);
  };

  const openEditModal = (offer) => {
    setEditingOffer(offer);
    form.setFieldsValue({
      code: offer.code,
      name: offer.name,
      capHour: offer.capHour || '10h',
      totalCap: offer.totalCap,
      pointsPerCap: offer.pointsPerCap,
      timeWindow: offer.timeWindow || 'Cả ngày',
      eligibilityType: offer.eligibilityType || 'all',
      eligibleMemberIds: offer.eligibleMemberIds || [],
      condition: offer.condition || 'Tất cả thành viên',
      note: offer.note || '',
      hidden: Boolean(offer.hidden),
    });
    setModalOpen(true);
  };

  const handleSaveForm = async () => {
    try {
      const values = await form.validateFields();
      const condLabel =
        values.eligibilityType === 'exclude_new'
          ? 'Không áp dụng cho thành viên mới'
          : values.eligibilityType === 'custom'
          ? `Chỉ định ${values.eligibleMemberIds?.length || 0} thành viên`
          : values.condition?.trim() || 'Tất cả thành viên';

      const payload = {
        code: values.code.trim(),
        name: values.name.trim(),
        capHour: values.capHour?.trim() || '10h',
        totalCap: Math.max(0, Math.round(Number(values.totalCap ?? 0))),
        pointsPerCap: Math.round(Number(values.pointsPerCap)),
        timeWindow: values.timeWindow?.trim() || 'Cả ngày',
        eligibilityType: values.eligibilityType || 'all',
        eligibleMemberIds: values.eligibilityType === 'custom' ? values.eligibleMemberIds || [] : [],
        condition: condLabel,
        note: values.note?.trim() || '',
        hidden: Boolean(values.hidden),
      };

      const normalizedCode = payload.code.trim().toLowerCase();
      const conflict = campaigns.find(
        (c) =>
          c.id !== editingOffer?.id &&
          String(c.code || '').trim().toLowerCase() === normalizedCode
      );
      if (conflict) {
        onNotify('warning', `ID offer "${payload.code}" đã tồn tại (${conflict.name}). Vui lòng sửa offer cũ hoặc dùng ID khác.`);
        return;
      }

      if (editingOffer) {
        onUpdateCampaign({ ...editingOffer, ...payload });
        onNotify('success', `Đã cập nhật offer ID ${payload.code}`);
      } else {
        onAddCampaign({ id: createId('offer'), ...payload });
        onNotify('success', `Đã thêm offer ID ${payload.code}`);
      }
      setModalOpen(false);
    } catch {
      // inline validation
    }
  };

  const handleImportFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    const buffer = await file.arrayBuffer();
    const res = parseCampaignsFromExcelBuffer(buffer);
    if (!res.ok) {
      onNotify('error', res.error);
      return;
    }

    const { merged, updatedCount, addedCount, duplicateInImportCount } = mergeOffersByCode(
      campaigns,
      res.campaigns
    );
    onReplaceCampaigns(sortOffersByPointsDesc(merged));

    const parts = [];
    if (updatedCount > 0) parts.push(`cập nhật ${updatedCount} offer trùng ID`);
    if (addedCount > 0) parts.push(`thêm mới ${addedCount} offer`);
    if (duplicateInImportCount > 0) parts.push(`gộp ${duplicateInImportCount} dòng trùng ID trong file`);
    onNotify('success', `Đã nhập Excel: ${parts.join(', ') || `${res.campaigns.length} offer`}.`);
  };

  const handleDeduplicateExisting = () => {
    const { merged } = mergeOffersByCode([], campaigns);
    const removed = campaigns.length - merged.length;
    onReplaceCampaigns(sortOffersByPointsDesc(merged));
    onNotify('success', `Đã gộp xong ${removed} offer trùng ID, giữ lại ${merged.length} offer duy nhất.`);
  };

  const handleBulkDelete = () => {
    if (selectedRowKeys.length === 0) return;
    const selectedSet = new Set(selectedRowKeys);
    const remaining = campaigns.filter((c) => !selectedSet.has(c.id));
    const count = campaigns.length - remaining.length;
    onReplaceCampaigns(remaining);
    setSelectedRowKeys([]);
    onNotify('success', `Đã xóa ${count} offer đã chọn.`);
  };

  const handleToggleHideOffer = (offer, nextHidden) => {
    onUpdateCampaign({ ...offer, hidden: Boolean(nextHidden) });
    onNotify(
      'success',
      nextHidden
        ? `Đã ẩn offer ID ${offer.code} khỏi bảng Chia CAP.`
        : `Đã hiện lại offer ID ${offer.code} bên Chia CAP.`
    );
  };

  const handleBulkToggleHidden = (nextHidden) => {
    if (selectedRowKeys.length === 0) return;
    const selectedSet = new Set(selectedRowKeys);
    const updated = campaigns.map((c) =>
      selectedSet.has(c.id) ? { ...c, hidden: Boolean(nextHidden) } : c
    );
    onReplaceCampaigns(updated);
    onNotify(
      'success',
      nextHidden
        ? `Đã ẩn ${selectedRowKeys.length} offer khỏi bảng Chia CAP.`
        : `Đã hiện lại ${selectedRowKeys.length} offer bên Chia CAP.`
    );
    setSelectedRowKeys([]);
  };

  const handleShowAllHidden = () => {
    if (hiddenOfferCount === 0) return;
    const updated = campaigns.map((c) => (c.hidden ? { ...c, hidden: false } : c));
    onReplaceCampaigns(updated);
    onNotify('success', `Đã hiện lại toàn bộ ${hiddenOfferCount} offer đang ẩn.`);
  };

  const handleBulkUpdateCapHour = () => {
    const nextHour = bulkCapHour.trim();
    if (!nextHour || selectedRowKeys.length === 0) {
      onNotify('warning', 'Vui lòng nhập giờ CAP chung cần áp dụng.');
      return;
    }
    const selectedSet = new Set(selectedRowKeys);
    const updated = campaigns.map((c) =>
      selectedSet.has(c.id) ? { ...c, capHour: nextHour } : c
    );
    onReplaceCampaigns(updated);
    onNotify('success', `Đã đổi giờ CAP chung thành "${nextHour}" cho ${selectedRowKeys.length} offer.`);
    setBulkHourModalOpen(false);
    setSelectedRowKeys([]);
  };

  const handleCopyFromHistory = () => {
    const found = history.find((h) => h.id === selectedHistoryId);
    if (!found) {
      onNotify('warning', 'Vui lòng chọn ngày muốn sao chép offer.');
      return;
    }
    const cloned = sortOffersByPointsDesc(
      (found.campaigns || []).map((c) => ({
        ...c,
        id: createId('offer'),
        hidden: false,
      }))
    );
    onReplaceCampaigns(cloned);
    setCopyModalOpen(false);
    onNotify('success', `Đã sao chép ${cloned.length} offer từ ngày ${found.date}.`);
  };

  const handleApplyQuickPaste = (mode) => {
    if (!pastePreview || !pastePreview.ok) {
      onNotify('warning', pastePreview?.error || 'Vui lòng dán danh sách offer hợp lệ.');
      return;
    }

    const cleaned = pastePreview.offers.map(({ isExistingMatch, ...rest }) => rest);

    if (mode === 'replace') {
      const { merged } = mergeOffersByCode([], cleaned);
      onReplaceCampaigns(sortOffersByPointsDesc(merged));
      setPasteModalOpen(false);
      setPasteText('');
      onNotify('success', `Đã thay thế toàn bộ bằng ${merged.length} offer vừa dán.`);
      return;
    }

    const { merged, updatedCount, addedCount } = mergeOffersByCode(campaigns, cleaned);
    onReplaceCampaigns(sortOffersByPointsDesc(merged));
    setPasteModalOpen(false);
    setPasteText('');
    onNotify(
      'success',
      `Đã cập nhật ${updatedCount} offer và thêm mới ${addedCount} offer.`
    );
  };

  const readImageFileToDataUrl = (file) => {
    if (!file || !file.type?.startsWith('image/')) {
      onNotify('warning', 'Vui lòng chọn tệp hình ảnh (PNG, JPG, WebP).');
      return;
    }
    if (file.size > 3.5 * 1024 * 1024) {
      onNotify('warning', 'Ảnh vượt quá giới hạn 3.5MB. Vui lòng cắt nhỏ hoặc nén nhẹ trước.');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setAiImageDataUrl(String(reader.result || ''));
      setAiImageMime(file.type || 'image/png');
      setAiError('');
    };
    reader.readAsDataURL(file);
  };

  const handleAiPasteEvent = (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.type && item.type.startsWith('image/')) {
        const blob = item.getAsFile();
        if (blob) {
          e.preventDefault();
          readImageFileToDataUrl(blob);
          return;
        }
      }
    }
  };

  const handleRunAiExtract = async () => {
    if (!activeGroup?.id) return;
    if (!aiInputText.trim() && !aiImageDataUrl) {
      setAiError('Vui lòng dán tin nhắn giao kèo hoặc tải/dán ảnh bảng Offer trước khi phân tích.');
      return;
    }
    setAiLoading(true);
    setAiError('');
    setAiSummary('');
    try {
      const res = await aiParseOffers({
        groupId: activeGroup.id,
        text: aiInputText,
        imageBase64: aiImageDataUrl,
        mimeType: aiImageMime,
        existingOffers: campaigns.map((c) => ({
          code: c.code,
          name: c.name,
          capHour: c.capHour,
          pointsPerCap: c.pointsPerCap,
        })),
      });
      if (!res.ok) {
        if (res.status === 401) {
          onRequestReauth?.();
        }
        setAiError(res.error || 'AI không thể phân tích dữ liệu Offer.');
        return;
      }

      const normalized = normalizeAiParsedOffers(res.data?.offers || [], campaigns);
      if (normalized.offers.length === 0) {
        setAiError('AI chưa trích xuất được Offer nào từ nội dung trên. Hãy bổ sung rõ hơn mã Offer và số CAP.');
        setAiExtractedOffers([]);
        setAiSelectedRowIds([]);
        return;
      }

      setAiSummary(String(res.data?.summary || ''));
      setAiExtractedOffers(normalized.offers);
      setAiSelectedRowIds(normalized.offers.map((o) => o.id));
    } finally {
      setAiLoading(false);
    }
  };

  const handleApplyAiExtracted = (mode) => {
    const picked = aiExtractedOffers
      .filter((o) => aiSelectedRowIds.includes(o.id))
      .map(({ isExistingMatch, ...rest }) => rest);
    if (picked.length === 0) {
      onNotify('warning', 'Vui lòng tích chọn ít nhất 1 Offer để lưu.');
      return;
    }

    if (mode === 'replace') {
      const { merged } = mergeOffersByCode([], picked);
      onReplaceCampaigns(sortOffersByPointsDesc(merged));
      setAiModalOpen(false);
      onNotify('success', `Đã thay thế toàn bộ bằng ${merged.length} offer từ AI.`);
      return;
    }

    const { merged, updatedCount, addedCount } = mergeOffersByCode(campaigns, picked);
    onReplaceCampaigns(sortOffersByPointsDesc(merged));
    setAiModalOpen(false);
    onNotify('success', `AI đã cập nhật ${updatedCount} offer và thêm mới ${addedCount} offer.`);
  };

  const columns = [
    {
      title: 'ID',
      dataIndex: 'code',
      key: 'code',
      width: 76,
      render: (code) => <span className="font-tabular font-semibold text-slate-900">{code}</span>,
    },
    {
      title: 'Name',
      dataIndex: 'name',
      key: 'name',
      width: 220,
      render: (name, offer) => (
        <div>
          <div className={`font-medium ${offer.hidden ? 'text-slate-400 line-through' : 'text-slate-900'}`}>
            {name}
          </div>
          {offer.hidden && (
            <div className="text-[11px] font-medium text-amber-700 mt-0.5">
              Đang ẩn khỏi bảng Chia CAP
            </div>
          )}
          {offer.note && <div className="text-xs text-slate-500 mt-0.5">{offer.note}</div>}
        </div>
      ),
    },
    {
      title: 'Giờ CAP chung',
      dataIndex: 'capHour',
      key: 'capHour',
      align: 'center',
      width: 112,
      render: (capHour) => (
        <span className="inline-flex items-center gap-1 font-tabular font-semibold text-slate-800 text-xs whitespace-nowrap">
          <Clock className="w-3.5 h-3.5 text-[#2563EB]" aria-hidden="true" />
          {capHour || '-'}
        </span>
      ),
    },
    {
      title: 'Số CAP',
      dataIndex: 'totalCap',
      key: 'totalCap',
      align: 'right',
      width: 78,
      render: (val) => <span className="font-tabular font-semibold text-slate-900">{val}</span>,
    },
    {
      title: 'Điểm/CAP',
      dataIndex: 'pointsPerCap',
      key: 'pointsPerCap',
      align: 'right',
      width: 96,
      render: (val) => (
        <span className="font-tabular font-medium text-slate-800 whitespace-nowrap">
          {val} point
        </span>
      ),
    },
    {
      title: 'Tổng điểm',
      key: 'totalPoints',
      align: 'right',
      width: 106,
      render: (_, offer) => (
        <span className="font-tabular font-semibold text-[#2563EB] whitespace-nowrap">
          {(Number(offer.totalCap) * Number(offer.pointsPerCap)).toLocaleString('vi-VN')} point
        </span>
      ),
    },
    {
      title: 'Điều kiện tham gia',
      dataIndex: 'condition',
      key: 'condition',
      width: 145,
      render: (cond, offer) => (
        <span className="text-xs text-slate-600">
          {offer.eligibilityType === 'exclude_new'
            ? 'Trừ thành viên mới'
            : offer.eligibilityType === 'custom'
            ? `Chỉ định (${offer.eligibleMemberIds?.length || 0} người)`
            : cond || 'Tất cả thành viên'}
        </span>
      ),
    },
    {
      title: 'Hiển thị',
      dataIndex: 'hidden',
      key: 'hidden',
      align: 'center',
      width: 112,
      render: (isHidden, offer) => {
        const isVisible = !isHidden;
        return (
          <div className="inline-flex items-center justify-center gap-1.5">
            {canEdit && (
              <Switch
                size="small"
                checked={isVisible}
                aria-label={`${isVisible ? 'Ẩn' : 'Hiện'} offer ${offer.code} khỏi chia CAP`}
                onChange={(checked) => handleToggleHideOffer(offer, !checked)}
              />
            )}
            <span
              className={`text-xs font-medium whitespace-nowrap ${
                isVisible ? 'text-emerald-700' : 'text-slate-400'
              }`}
            >
              {isVisible ? 'Đang bật' : 'Đang ẩn'}
            </span>
          </div>
        );
      },
    },
    {
      title: 'Thao tác',
      key: 'actions',
      align: 'right',
      width: 86,
      render: (_, offer) =>
        canEdit ? (
          <div className="flex items-center justify-end gap-1">
            <Button
              type="text"
              size="small"
              aria-label={`Sửa offer ${offer.code}`}
              icon={<Pencil className="w-4 h-4 text-slate-600" />}
              onClick={() => openEditModal(offer)}
            />
            <Popconfirm
              title="Xóa offer này?"
              description={`Bạn có chắc muốn xóa offer ID ${offer.code}?`}
              okText="Xóa"
              cancelText="Hủy"
              okButtonProps={{ danger: true }}
              onConfirm={() => onDeleteCampaign(offer.id)}
            >
              <Button
                type="text"
                size="small"
                danger
                aria-label={`Xóa offer ${offer.code}`}
                icon={<Trash2 className="w-4 h-4" />}
              />
            </Popconfirm>
          </div>
        ) : (
          <span className="text-xs text-slate-400">Chỉ xem</span>
        ),
    },
  ];

  return (
    <div className="flex flex-col gap-5">
      {!canEdit && (
        <Alert
          type="info"
          showIcon
          title={`Chế độ xem offer – ${activeGroup?.name}`}
          description={
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs sm:text-sm">
              <span>Đăng nhập tài khoản Leader của nhóm để thêm, sửa, xóa hoặc nhập offer từ Excel.</span>
              <Button size="small" type="primary" icon={<KeyRound className="w-3.5 h-3.5" />} onClick={onOpenLogin}>
                Đăng nhập Leader
              </Button>
            </div>
          }
        />
      )}

      {/* Toolbar */}
      <section className="cap-card p-4 flex flex-col lg:flex-row lg:items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <Input
            placeholder="Tìm theo ID, Name, giờ CAP chung (10h, 23h)..."
            prefix={<Search className="w-4 h-4 text-slate-400" />}
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            allowClear
            className="w-full sm:w-80"
          />
          <div className="text-xs text-slate-500 font-tabular flex flex-wrap items-center gap-2">
            <span>
              {hiddenOfferCount > 0
                ? `${activeOfferCount}/${campaigns.length} offer đang bật (${hiddenOfferCount} đang ẩn) · ${totalCap} CAP · ${totalPoints.toLocaleString('vi-VN')} point`
                : `${filteredOffers.length} offer · ${totalCap} CAP · ${totalPoints.toLocaleString('vi-VN')} point (xếp điểm cao trước)`}
            </span>
            {canEdit && hiddenOfferCount > 0 && (
              <Button size="small" icon={<Eye className="w-3.5 h-3.5" />} onClick={handleShowAllHidden}>
                Hiện tất cả ({hiddenOfferCount})
              </Button>
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept=".xlsx,.xls,.csv"
            className="hidden"
            onChange={handleImportFile}
          />
          <Button
            icon={<Download className="w-4 h-4" />}
            onClick={downloadCampaignTemplateExcel}
          >
            File mẫu
          </Button>
          {canEdit && (
            <>
              <Button
                icon={<Sparkles className="w-4 h-4 text-[#2563EB]" />}
                onClick={() => {
                  setAiError('');
                  setAiSummary('');
                  setAiExtractedOffers([]);
                  setAiSelectedRowIds([]);
                  setAiModalOpen(true);
                }}
              >
                AI Nhập từ Ảnh / Tin nhắn
              </Button>
              <Button
                icon={<ClipboardPaste className="w-4 h-4" />}
                onClick={() => {
                  setPasteText('');
                  setPasteModalOpen(true);
                }}
              >
                Dán từ Sheet
              </Button>
              <Button
                icon={<Upload className="w-4 h-4" />}
                onClick={() => fileInputRef.current?.click()}
              >
                Nhập Excel
              </Button>
              {history.length > 0 && (
                <Button
                  icon={<Copy className="w-4 h-4" />}
                  onClick={() => {
                    setSelectedHistoryId(history[0]?.id || null);
                    setCopyModalOpen(true);
                  }}
                >
                  Sao chép từ ngày trước
                </Button>
              )}
              <Button
                type="primary"
                icon={<Plus className="w-4 h-4" />}
                onClick={openAddModal}
                className="font-medium"
              >
                Thêm offer
              </Button>
            </>
          )}
        </div>
      </section>

      {canEdit && duplicateCodes.length > 0 && (
        <Alert
          type="warning"
          showIcon
          title={`Phát hiện ${duplicateCodes.length} ID offer bị trùng (${duplicateCodes
            .slice(0, 5)
            .map((d) => `${d.code} (×${d.count})`)
            .join(', ')}${duplicateCodes.length > 5 ? '...' : ''})`}
          description={
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs sm:text-sm">
              <span>Nhấn "Gộp ID trùng" để giữ lại bản mới nhất cho từng ID và tránh chia trùng CAP.</span>
              <Button size="small" type="primary" onClick={handleDeduplicateExisting}>
                Gộp ID trùng
              </Button>
            </div>
          }
        />
      )}

      {/* Offers Table */}
      <section className="cap-card p-4">
        {canEdit && selectedRowKeys.length > 0 && (
          <div className="mb-3 px-3 py-2 rounded-lg bg-[#EFF6FF] border border-blue-200 flex flex-wrap items-center justify-between gap-2">
            <div className="text-xs sm:text-sm font-medium text-slate-800 font-tabular">
              Đã chọn <strong className="text-[#1D4ED8]">{selectedRowKeys.length}</strong> offer
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button size="small" onClick={() => setSelectedRowKeys([])}>
                Bỏ chọn
              </Button>
              <Button
                size="small"
                icon={<EyeOff className="w-3.5 h-3.5" />}
                onClick={() => handleBulkToggleHidden(true)}
              >
                Ẩn đã chọn ({selectedRowKeys.length})
              </Button>
              <Button
                size="small"
                icon={<Eye className="w-3.5 h-3.5" />}
                onClick={() => handleBulkToggleHidden(false)}
              >
                Hiện đã chọn ({selectedRowKeys.length})
              </Button>
              <Button
                size="small"
                icon={<Clock className="w-3.5 h-3.5" />}
                onClick={() => {
                  setBulkCapHour('10h');
                  setBulkHourModalOpen(true);
                }}
              >
                Đổi giờ CAP chung ({selectedRowKeys.length})
              </Button>
              <Popconfirm
                title={`Xóa ${selectedRowKeys.length} offer đã chọn?`}
                description="Thao tác này sẽ xóa toàn bộ các offer đang tích chọn."
                okText="Xóa"
                cancelText="Hủy"
                okButtonProps={{ danger: true }}
                onConfirm={handleBulkDelete}
              >
                <Button size="small" danger icon={<Trash2 className="w-3.5 h-3.5" />}>
                  Xóa đã chọn ({selectedRowKeys.length})
                </Button>
              </Popconfirm>
            </div>
          </div>
        )}

        <Table
          dataSource={filteredOffers}
          columns={columns}
          rowKey="id"
          rowClassName={(record) => (record.hidden ? 'bg-slate-50/90 opacity-65' : '')}
          rowSelection={
            canEdit
              ? {
                  selectedRowKeys,
                  onChange: (keys) => setSelectedRowKeys(keys),
                }
              : undefined
          }
          pagination={false}
          size="middle"
          scroll={{ x: 980 }}
          locale={{ emptyText: 'Chưa có offer nào. Nhấn "Thêm offer" để bắt đầu.' }}
        />
      </section>

      {/* Add/Edit Offer Modal */}
      <Modal
        title={editingOffer ? `Sửa offer ID ${editingOffer.code}` : 'Thêm offer mới'}
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        onOk={handleSaveForm}
        okText={editingOffer ? 'Lưu thay đổi' : 'Thêm offer'}
        cancelText="Hủy"
        width={600}
      >
        <Form form={form} layout="vertical" className="mt-3">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-x-4">
            <Form.Item
              name="code"
              label="ID"
              rules={[{ required: true, message: 'Vui lòng nhập ID offer' }]}
            >
              <Input placeholder="Ví dụ: 1551" />
            </Form.Item>
            <Form.Item
              name="capHour"
              label="Giờ CAP chung"
              rules={[{ required: true, message: 'Nhập giờ CAP chung (vd: 10h, 23h)' }]}
            >
              <Input placeholder="Ví dụ: 10h, 21h30, 23h" />
            </Form.Item>
            <Form.Item
              name="timeWindow"
              label="Thời gian thực hiện"
            >
              <Input placeholder="Ví dụ: 10h (Cả ngày)" />
            </Form.Item>
          </div>

          <Form.Item
            name="name"
            label="Name"
            rules={[{ required: true, message: 'Vui lòng nhập Name offer' }]}
          >
            <Input placeholder="Ví dụ: 21997905 - EverydayHealth - Diabetes Snacks" />
          </Form.Item>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4">
            <Form.Item
              name="totalCap"
              label="Số CAP của cả nhóm"
              rules={[
                { required: true, message: 'Nhập số CAP' },
                { type: 'number', min: 0, message: 'Số CAP không được âm' },
              ]}
            >
              <InputNumber min={0} max={1000} precision={0} className="w-full" />
            </Form.Item>

            <Form.Item
              name="pointsPerCap"
              label="Điểm cho mỗi CAP (point)"
              rules={[
                { required: true, message: 'Nhập point/CAP' },
                { type: 'number', min: 1, message: 'Point/CAP phải lớn hơn 0' },
              ]}
            >
              <InputNumber min={1} max={10000} precision={0} className="w-full" />
            </Form.Item>
          </div>

          <Form.Item name="eligibilityType" label="Điều kiện tham gia">
            <Select
              options={[
                { value: 'all', label: 'Tất cả thành viên đang hoạt động' },
                { value: 'exclude_new', label: 'Không áp dụng cho thành viên mới' },
                { value: 'custom', label: 'Chọn thành viên đủ điều kiện cụ thể' },
              ]}
            />
          </Form.Item>

          {eligibilityTypeValue === 'custom' && (
            <Form.Item
              name="eligibleMemberIds"
              label="Danh sách thành viên đủ điều kiện"
              rules={[
                {
                  required: true,
                  type: 'array',
                  min: 1,
                  message: 'Vui lòng chọn ít nhất 1 thành viên',
                },
              ]}
            >
              <Select
                mode="multiple"
                placeholder="Chọn thành viên..."
                options={members.map((m) => ({
                  value: m.id,
                  label: `${m.name}${m.active === false ? ' (Tạm nghỉ)' : ''}`,
                }))}
              />
            </Form.Item>
          )}

          {eligibilityTypeValue === 'all' && (
            <Form.Item name="condition" label="Mô tả điều kiện (nếu có)">
              <Input placeholder="Ví dụ: Tất cả thành viên" />
            </Form.Item>
          )}

          <Form.Item name="note" label="Ghi chú">
            <Input.TextArea rows={2} placeholder="Ghi chú thêm cho offer..." />
          </Form.Item>

          <Form.Item
            name="hidden"
            label="Ẩn khỏi bảng Chia CAP (vẫn giữ lại trong Quản lý offer)"
            valuePropName="checked"
            className="mb-0"
          >
            <Switch checkedChildren="Đang ẩn" unCheckedChildren="Đang bật" />
          </Form.Item>
        </Form>
      </Modal>

      {/* Copy from History Modal */}
      <Modal
        title="Sao chép danh sách offer từ lịch sử"
        open={copyModalOpen}
        onCancel={() => setCopyModalOpen(false)}
        onOk={handleCopyFromHistory}
        okText="Sao chép offer"
        cancelText="Hủy"
      >
        <div className="py-2 flex flex-col gap-3">
          <p className="text-sm text-slate-600 m-0">
            Chọn một ngày đã lưu để sao chép toàn bộ danh sách offer sang danh sách hiện tại.
          </p>
          <Select
            value={selectedHistoryId}
            onChange={setSelectedHistoryId}
            className="w-full"
            options={history.map((h) => ({
              value: h.id,
              label: `${h.date} · ${h.campaigns?.length || 0} offer · ${h.stats?.assignedTotalCap || 0} CAP${h.note ? ` (${h.note})` : ''}`,
            }))}
          />
        </div>
      </Modal>

      {/* Quick Paste Offers Modal */}
      <Modal
        title="Dán nhanh offer từ Google Sheets / Excel"
        open={pasteModalOpen}
        onCancel={() => setPasteModalOpen(false)}
        width={760}
        footer={[
          <Button key="cancel" onClick={() => setPasteModalOpen(false)}>
            Hủy
          </Button>,
          <Button
            key="replace"
            danger
            disabled={!pastePreview?.ok}
            onClick={() => handleApplyQuickPaste('replace')}
          >
            Thay thế toàn bộ
          </Button>,
          <Button
            key="merge"
            type="primary"
            disabled={!pastePreview?.ok}
            onClick={() => handleApplyQuickPaste('merge')}
          >
            Cập nhật &amp; Thêm mới
          </Button>,
        ]}
      >
        <div className="flex flex-col gap-3 py-1">
          <p className="text-xs sm:text-sm text-slate-600 m-0">
            Copy trực tiếp các dòng từ Google Sheets hoặc Excel theo thứ tự cột:{' '}
            <strong className="text-slate-900">ID | Name | Giờ CAP chung | Tổng CAP | Điểm/CAP</strong>{' '}
            (hoặc chỉ 2 cột ID | Name, các thông số khác sẽ giữ theo offer cũ hoặc mặc định).
          </p>

          <Input.TextArea
            rows={5}
            value={pasteText}
            onChange={(e) => setPasteText(e.target.value)}
            placeholder={`Ví dụ (copy từ Sheet hoặc ngăn cách bởi Tab / dấu | ):\n1769\t21997905 - EverydayHealth\t10h\t8\t35\n2045\tNew Offer Campaign\t23h\t6\t25`}
            className="font-mono text-xs"
          />

          {pastePreview && !pastePreview.ok && (
            <Alert type="warning" showIcon title={pastePreview.error} />
          )}

          {pastePreview?.ok && (
            <div className="flex flex-col gap-2">
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-600 font-tabular">
                <span>
                  Nhận diện <strong className="text-slate-900">{pastePreview.offers.length}</strong> offer hợp lệ
                  {' · '}
                  <strong className="text-[#2563EB]">{pastePreview.matchedCount}</strong> trùng ID (sẽ cập nhật)
                  {' · '}
                  <strong className="text-emerald-700">{pastePreview.newCount}</strong> thêm mới
                </span>
                {pastePreview.skippedCount > 0 && (
                  <span className="text-amber-700">Bỏ qua {pastePreview.skippedCount} dòng thiếu dữ liệu</span>
                )}
              </div>

              <Table
                dataSource={pastePreview.offers}
                rowKey="id"
                size="small"
                pagination={false}
                scroll={{ y: 210, x: 640 }}
                columns={[
                  {
                    title: 'ID',
                    dataIndex: 'code',
                    width: 80,
                    render: (v) => <span className="font-tabular font-semibold text-slate-900">{v}</span>,
                  },
                  {
                    title: 'Name',
                    dataIndex: 'name',
                    ellipsis: true,
                  },
                  {
                    title: 'Giờ CAP chung',
                    dataIndex: 'capHour',
                    width: 108,
                    align: 'center',
                    render: (v) => <span className="font-tabular font-medium">{v}</span>,
                  },
                  {
                    title: 'CAP',
                    dataIndex: 'totalCap',
                    width: 66,
                    align: 'right',
                    render: (v) => <span className="font-tabular font-semibold">{v}</span>,
                  },
                  {
                    title: 'Điểm/CAP',
                    dataIndex: 'pointsPerCap',
                    width: 86,
                    align: 'right',
                    render: (v) => <span className="font-tabular">{v} point</span>,
                  },
                  {
                    title: 'Xử lý',
                    key: 'mode',
                    width: 96,
                    align: 'right',
                    render: (_, row) => (
                      <span
                        className={`text-xs font-semibold ${
                          row.isExistingMatch ? 'text-[#2563EB]' : 'text-emerald-700'
                        }`}
                      >
                        {row.isExistingMatch ? 'Cập nhật' : 'Thêm mới'}
                      </span>
                    ),
                  },
                ]}
              />
            </div>
          )}
        </div>
      </Modal>

      {/* Bulk Change CAP Hour Modal */}
      <Modal
        title={`Đổi giờ CAP chung hàng loạt (${selectedRowKeys.length} offer)`}
        open={bulkHourModalOpen}
        onCancel={() => setBulkHourModalOpen(false)}
        onOk={handleBulkUpdateCapHour}
        okText="Áp dụng giờ mới"
        cancelText="Hủy"
        width={400}
      >
        <div className="py-2 flex flex-col gap-3">
          <p className="text-xs sm:text-sm text-slate-600 m-0">
            Nhập Giờ CAP chung muốn áp dụng cho toàn bộ{' '}
            <strong className="font-tabular text-slate-900">{selectedRowKeys.length}</strong> offer đã chọn:
          </p>
          <Input
            value={bulkCapHour}
            onChange={(e) => setBulkCapHour(e.target.value)}
            placeholder="Ví dụ: 10h, 21h30, 23h"
            onPressEnter={handleBulkUpdateCapHour}
          />
          <div className="flex flex-wrap items-center gap-1.5">
            {['10h', '21h30', '23h'].map((preset) => (
              <button
                key={preset}
                type="button"
                onClick={() => setBulkCapHour(preset)}
                className={`px-2.5 py-1 text-xs font-tabular font-medium rounded border cursor-pointer transition-colors ${
                  bulkCapHour === preset
                    ? 'bg-[#EFF6FF] border-[#2563EB] text-[#1D4ED8]'
                    : 'bg-slate-50 border-slate-200 text-slate-700 hover:bg-slate-100'
                }`}
              >
                {preset}
              </button>
            ))}
            </div>
          </div>
      </Modal>

      {/* AI Offer Extraction Modal */}
      <Modal
        title="AI Trích xuất Offer từ Ảnh & Tin nhắn tiếng Việt"
        open={aiModalOpen}
        onCancel={() => setAiModalOpen(false)}
        width={860}
        footer={[
          <Button key="cancel" onClick={() => setAiModalOpen(false)}>
            Đóng
          </Button>,
          <Button
            key="replace"
            danger
            disabled={aiSelectedRowIds.length === 0 || aiLoading}
            onClick={() => handleApplyAiExtracted('replace')}
          >
            Thay thế toàn bộ ({aiSelectedRowIds.length})
          </Button>,
          <Button
            key="merge"
            type="primary"
            disabled={aiSelectedRowIds.length === 0 || aiLoading}
            onClick={() => handleApplyAiExtracted('merge')}
          >
            Cập nhật &amp; Thêm mới ({aiSelectedRowIds.length})
          </Button>,
        ]}
      >
        <div className="flex flex-col gap-3.5 py-1" onPaste={handleAiPasteEvent}>
          <input
            ref={aiImageInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (f) readImageFileToDataUrl(f);
            }}
          />

          <p className="text-xs sm:text-sm text-slate-600 m-0">
            Dán trực tiếp tin nhắn giao kèo bằng tiếng Việt và/hoặc dán ảnh (<kbd className="px-1 py-0.5 bg-slate-100 rounded border border-slate-300 text-[11px]">Ctrl+V</kbd>) hoặc chọn ảnh chụp bảng Offer để AI tự tách mã, số CAP, điểm và điều kiện cho bạn kiểm tra trước khi lưu.
          </p>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div className="md:col-span-2 flex flex-col gap-1.5">
              <label htmlFor="ai-offer-text-input" className="text-xs font-medium text-slate-700">
                Tin nhắn / mô tả Offer (không bắt buộc nếu có ảnh)
              </label>
              <Input.TextArea
                id="ai-offer-text-input"
                rows={5}
                value={aiInputText}
                onChange={(e) => setAiInputText(e.target.value)}
                placeholder="Ví dụ: Nay chạy 1769 8 cap 35p giờ 10h; thêm con 936 6 cap 25p chốt 23h, không cho newbie..."
                className="text-xs"
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-slate-700">Ảnh chụp bảng Offer</span>
              {aiImageDataUrl ? (
                <div className="relative rounded-lg border border-slate-200 bg-slate-50 p-1.5 flex flex-col items-center gap-1.5">
                  <img
                    src={aiImageDataUrl}
                    alt="Ảnh bảng Offer"
                    className="max-h-28 w-auto rounded object-contain"
                  />
                  <Button
                    size="small"
                    danger
                    type="text"
                    icon={<X className="w-3.5 h-3.5" />}
                    onClick={() => setAiImageDataUrl('')}
                  >
                    Bỏ ảnh
                  </Button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => aiImageInputRef.current?.click()}
                  className="h-full min-h-[112px] rounded-lg border border-dashed border-slate-300 hover:border-[#2563EB] hover:bg-blue-50/40 bg-slate-50 flex flex-col items-center justify-center gap-1.5 text-xs text-slate-600 cursor-pointer transition-colors p-3 text-center"
                >
                  <ImagePlus className="w-5 h-5 text-[#2563EB]" aria-hidden="true" />
                  <span className="font-medium">Chọn ảnh hoặc Ctrl+V</span>
                  <span className="text-[11px] text-slate-400">PNG / JPG / WebP (&le; 3.5MB)</span>
                </button>
              )}
            </div>
          </div>

          <div className="flex items-center justify-between gap-2">
            <Button
              type="primary"
              icon={<Sparkles className="w-4 h-4" />}
              loading={aiLoading}
              onClick={handleRunAiExtract}
            >
              Phân tích bằng AI
            </Button>
            {aiSummary && (
              <span className="text-xs text-emerald-700 font-medium">{aiSummary}</span>
            )}
          </div>

          {aiError && <Alert type="error" showIcon title={aiError} />}

          {aiExtractedOffers.length > 0 && (
            <div className="flex flex-col gap-2">
              <div className="text-xs text-slate-600 font-tabular">
                AI nhận diện <strong className="text-slate-900">{aiExtractedOffers.length}</strong> offer — kiểm tra và chỉnh lại nhanh nếu cần trước khi lưu:
              </div>
              <Table
                dataSource={aiExtractedOffers}
                rowKey="id"
                size="small"
                pagination={false}
                rowSelection={{
                  selectedRowKeys: aiSelectedRowIds,
                  onChange: (keys) => setAiSelectedRowIds(keys),
                }}
                scroll={{ y: 230, x: 720 }}
                columns={[
                  {
                    title: 'Mã',
                    dataIndex: 'code',
                    width: 90,
                    render: (val, row, idx) => (
                      <Input
                        size="small"
                        value={val}
                        className="font-tabular font-semibold"
                        onChange={(e) => {
                          const v = e.target.value;
                          setAiExtractedOffers((prev) =>
                            prev.map((item, i) => (i === idx ? { ...item, code: v } : item))
                          );
                        }}
                      />
                    ),
                  },
                  {
                    title: 'Tên Offer',
                    dataIndex: 'name',
                    render: (val, _row, idx) => (
                      <Input
                        size="small"
                        value={val}
                        onChange={(e) => {
                          const v = e.target.value;
                          setAiExtractedOffers((prev) =>
                            prev.map((item, i) => (i === idx ? { ...item, name: v } : item))
                          );
                        }}
                      />
                    ),
                  },
                  {
                    title: 'Giờ CAP chung',
                    dataIndex: 'capHour',
                    width: 108,
                    render: (val, _row, idx) => (
                      <Input
                        size="small"
                        value={val}
                        className="font-tabular"
                        onChange={(e) => {
                          const v = e.target.value;
                          setAiExtractedOffers((prev) =>
                            prev.map((item, i) => (i === idx ? { ...item, capHour: v } : item))
                          );
                        }}
                      />
                    ),
                  },
                  {
                    title: 'CAP',
                    dataIndex: 'totalCap',
                    width: 78,
                    render: (val, _row, idx) => (
                      <InputNumber
                        size="small"
                        min={0}
                        max={1000}
                        value={val}
                        className="w-full font-tabular"
                        onChange={(v) => {
                          const parsed = Number(v);
                          const safeCap = Number.isFinite(parsed) ? Math.max(0, Math.round(parsed)) : 0;
                          setAiExtractedOffers((prev) =>
                            prev.map((item, i) => (i === idx ? { ...item, totalCap: safeCap } : item))
                          );
                        }}
                      />
                    ),
                  },
                  {
                    title: 'Điểm/CAP',
                    dataIndex: 'pointsPerCap',
                    width: 88,
                    render: (val, _row, idx) => (
                      <InputNumber
                        size="small"
                        min={1}
                        max={10000}
                        value={val}
                        className="w-full font-tabular"
                        onChange={(v) => {
                          setAiExtractedOffers((prev) =>
                            prev.map((item, i) => (i === idx ? { ...item, pointsPerCap: Number(v) || 1 } : item))
                          );
                        }}
                      />
                    ),
                  },
                  {
                    title: 'Trạng thái',
                    key: 'mode',
                    width: 96,
                    render: (_, row) => (
                      <span
                        className={`text-xs font-semibold ${
                          row.isExistingMatch ? 'text-[#2563EB]' : 'text-emerald-700'
                        }`}
                      >
                        {row.isExistingMatch ? 'Cập nhật' : 'Thêm mới'}
                      </span>
                    ),
                  },
                ]}
              />
            </div>
          )}
        </div>
      </Modal>
    </div>
  );
}
