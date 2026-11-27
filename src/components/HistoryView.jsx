import React, { useMemo, useState } from 'react';
import { Button, Empty, Modal, Popconfirm, Table } from 'antd';
import {
  Eye,
  FolderOpen,
  Copy,
  FileSpreadsheet,
  Trash2,
} from 'lucide-react';
import { exportDistributionToExcel } from '../utils/excelService.js';
import { computeDistributionStats, sortOffersByPointsDesc } from '../utils/capAlgorithm.js';
import { formatGroupDistributionSummaryText } from '../utils/shareText.js';

async function copyTextSafe(text) {
  if (!text) return false;
  try {
    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fallback below
  }
  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(textarea);
    return ok;
  } catch {
    return false;
  }
}

export default function HistoryView({
  groupName = 'Nhóm',
  history,
  onReopenHistory,
  onCopyCampaignsFromHistory,
  onDeleteHistory,
  onNotify,
}) {
  const [inspectRecord, setInspectRecord] = useState(null);

  const inspectStats = useMemo(() => {
    if (!inspectRecord) return null;
    return computeDistributionStats(
      inspectRecord.matrix || {},
      inspectRecord.campaigns || [],
      inspectRecord.members || [],
      inspectRecord.date
    );
  }, [inspectRecord]);

  const handleCopyInspectSummary = async () => {
    if (!inspectRecord || !inspectStats) return;
    const text = formatGroupDistributionSummaryText({
      groupName,
      distributionDate: inspectRecord.date,
      members: inspectRecord.members || [],
      campaigns: sortOffersByPointsDesc(inspectRecord.campaigns || []),
      matrix: inspectRecord.matrix || {},
      stats: inspectStats,
    });
    const ok = await copyTextSafe(text);
    onNotify(
      ok ? 'success' : 'error',
      ok
        ? `Đã sao chép tóm tắt lịch sử ngày ${inspectRecord.date}.`
        : 'Trình duyệt chặn tự động sao chép. Vui lòng thử lại.'
    );
  };

  const handleExportRecord = (record) => {
    const res = exportDistributionToExcel({
      matrix: record.matrix,
      campaigns: record.campaigns,
      members: record.members,
      dateLabel: record.date,
      fileName: `CAP_Manager_${record.date}.xlsx`,
    });
    if (!res.ok) {
      onNotify('error', res.error);
    } else {
      onNotify('success', `Đã xuất file Excel lịch sử ngày ${record.date}`);
    }
  };

  const columns = [
    {
      title: 'Ngày lưu',
      dataIndex: 'date',
      key: 'date',
      width: 130,
      render: (date, rec) => (
        <div>
          <div className="font-tabular font-semibold text-slate-900">{date}</div>
          <div className="text-[11px] text-slate-400 font-tabular">
            {new Date(rec.savedAt).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })}
          </div>
        </div>
      ),
    },
    {
      title: 'Ghi chú',
      dataIndex: 'note',
      key: 'note',
      minWidth: 180,
      render: (note) => <span className="text-slate-700 text-sm">{note || '—'}</span>,
    },
    {
      title: 'Offer',
      key: 'campaignCount',
      align: 'right',
      width: 90,
      render: (_, rec) => (
        <span className="font-tabular text-slate-700">{rec.campaigns?.length || 0}</span>
      ),
    },
    {
      title: 'Tổng CAP',
      key: 'totalCap',
      align: 'right',
      width: 100,
      render: (_, rec) => (
        <span className="font-tabular font-semibold text-slate-900">
          {rec.stats?.assignedTotalCap || 0}
        </span>
      ),
    },
    {
      title: 'Tổng điểm',
      key: 'totalPoints',
      align: 'right',
      width: 135,
      render: (_, rec) => (
        <span className="font-tabular font-semibold text-[#2563EB] whitespace-nowrap">
          {(rec.stats?.assignedTotalPoints || 0).toLocaleString('vi-VN')} point
        </span>
      ),
    },
    {
      title: 'Chênh lệch',
      key: 'spread',
      align: 'right',
      width: 175,
      render: (_, rec) => (
        <span className="font-tabular text-xs text-slate-600 whitespace-nowrap">
          CAP: {rec.stats?.capSpread ?? 0} · {rec.stats?.pointSpread ?? 0} point
        </span>
      ),
    },
    {
      title: 'Thao tác',
      key: 'actions',
      align: 'right',
      width: 340,
      render: (_, rec) => (
        <div className="flex flex-wrap items-center justify-end gap-1.5">
          <Button
            size="small"
            icon={<Eye className="w-3.5 h-3.5" />}
            onClick={() => setInspectRecord(rec)}
          >
            Xem
          </Button>
          <Button
            size="small"
            type="primary"
            ghost
            icon={<FolderOpen className="w-3.5 h-3.5" />}
            onClick={() => onReopenHistory(rec)}
          >
            Mở lại
          </Button>
          <Button
            size="small"
            icon={<Copy className="w-3.5 h-3.5" />}
            onClick={() => onCopyCampaignsFromHistory(rec)}
          >
            Chép offer
          </Button>
          <Button
            size="small"
            icon={<FileSpreadsheet className="w-3.5 h-3.5" />}
            onClick={() => handleExportRecord(rec)}
          >
            Excel
          </Button>
          <Popconfirm
            title="Xóa bản lưu này?"
            okText="Xóa"
            cancelText="Hủy"
            okButtonProps={{ danger: true }}
            onConfirm={() => onDeleteHistory(rec.id)}
          >
            <Button
              size="small"
              danger
              aria-label={`Xóa lịch sử ngày ${rec.date}`}
              icon={<Trash2 className="w-3.5 h-3.5" />}
            />
          </Popconfirm>
        </div>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-5">
      <section className="cap-card p-4 sm:p-5">
        <div className="mb-4">
          <h2 className="text-base font-semibold text-slate-900 m-0">
            Lịch sử phân chia CAP theo ngày
          </h2>
          <p className="text-xs text-slate-500 mt-0.5 mb-0">
            Xem lại các ngày đã chia, mở lại bảng phân chia để chỉnh sửa, sao chép danh sách offer sang hôm nay hoặc xuất Excel trực tiếp.
          </p>
        </div>

        {history.length > 0 ? (
          <Table
            dataSource={history}
            columns={columns}
            rowKey="id"
            pagination={{ pageSize: 10, hideOnSinglePage: true }}
            size="middle"
            scroll={{ x: 1040 }}
          />
        ) : (
          <Empty
            description='Chưa có lịch sử nào được lưu. Vào mục "Chia CAP" và nhấn "Lưu vào lịch sử" sau khi phân chia.'
            className="py-12"
          />
        )}
      </section>

      {/* Inspect History Detail Modal */}
      <Modal
        title={inspectRecord ? `Chi tiết phân chia ngày ${inspectRecord.date}` : ''}
        open={Boolean(inspectRecord)}
        onCancel={() => setInspectRecord(null)}
        width={980}
        footer={
          inspectRecord
            ? [
                <Button key="close" onClick={() => setInspectRecord(null)}>
                  Đóng
                </Button>,
                <Button
                  key="copy"
                  icon={<Copy className="w-4 h-4" />}
                  onClick={handleCopyInspectSummary}
                >
                  Copy tóm tắt
                </Button>,
                <Button
                  key="excel"
                  icon={<FileSpreadsheet className="w-4 h-4" />}
                  onClick={() => handleExportRecord(inspectRecord)}
                >
                  Xuất Excel
                </Button>,
                <Button
                  key="reopen"
                  type="primary"
                  icon={<FolderOpen className="w-4 h-4" />}
                  onClick={() => {
                    onReopenHistory(inspectRecord);
                    setInspectRecord(null);
                  }}
                >
                  Mở lại để chỉnh sửa
                </Button>,
              ]
            : null
        }
      >
        {inspectRecord && (
          <div className="flex flex-col gap-4 pt-2">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 p-3 rounded-lg bg-slate-50 border border-slate-200 text-xs">
              <div>
                <div className="text-slate-500">Tổng offer</div>
                <div className="font-tabular font-bold text-sm text-slate-900 mt-0.5">
                  {inspectRecord.campaigns?.length || 0}
                </div>
              </div>
              <div>
                <div className="text-slate-500">Tổng CAP</div>
                <div className="font-tabular font-bold text-sm text-slate-900 mt-0.5">
                  {inspectRecord.stats?.assignedTotalCap || 0}
                </div>
              </div>
              <div>
                <div className="text-slate-500">Tổng điểm</div>
                <div className="font-tabular font-bold text-sm text-[#2563EB] mt-0.5">
                  {(inspectRecord.stats?.assignedTotalPoints || 0).toLocaleString('vi-VN')} point
                </div>
              </div>
              <div>
                <div className="text-slate-500">Chênh lệch CAP / Điểm</div>
                <div className="font-tabular font-bold text-sm text-slate-900 mt-0.5">
                  {inspectRecord.stats?.capSpread ?? 0} / {inspectRecord.stats?.pointSpread ?? 0} point
                </div>
              </div>
            </div>

            <Table
              dataSource={sortOffersByPointsDesc(inspectRecord.campaigns || [])}
              rowKey="id"
              pagination={false}
              size="small"
              bordered
              scroll={{ x: 820 }}
              columns={[
                {
                  title: 'ID',
                  dataIndex: 'code',
                  key: 'code',
                  width: 85,
                  render: (code) => <span className="font-tabular font-semibold">{code}</span>,
                },
                {
                  title: 'Name',
                  dataIndex: 'name',
                  key: 'name',
                  width: 210,
                  render: (name) => <span className="text-xs">{name}</span>,
                },
                {
                  title: 'CAP',
                  dataIndex: 'totalCap',
                  key: 'totalCap',
                  align: 'right',
                  width: 65,
                  render: (v) => <span className="font-tabular">{v}</span>,
                },
                {
                  title: 'Điểm/CAP',
                  dataIndex: 'pointsPerCap',
                  key: 'pointsPerCap',
                  align: 'right',
                  width: 92,
                  render: (v) => <span className="font-tabular whitespace-nowrap">{v} point</span>,
                },
                ...(inspectRecord.members || []).map((m) => ({
                  title: m.name,
                  key: m.id,
                  align: 'center',
                  width: 95,
                  render: (_, camp) => {
                    const val = inspectRecord.matrix?.[camp.id]?.[m.id] ?? 0;
                    return (
                      <span
                        className={`font-tabular ${
                          val > 0 ? 'font-semibold text-slate-900' : 'text-slate-300'
                        }`}
                      >
                        {val}
                      </span>
                    );
                  },
                })),
              ]}
              summary={() =>
                inspectStats ? (
                  <Table.Summary>
                    <Table.Summary.Row className="bg-[#EFF6FF] font-semibold">
                      <Table.Summary.Cell index={0} colSpan={2} className="font-semibold text-[#0F172A]">
                        TỔNG CAP
                      </Table.Summary.Cell>
                      <Table.Summary.Cell index={2} align="right" className="font-tabular font-bold text-[#0F172A]">
                        {inspectStats.assignedTotalCap}
                      </Table.Summary.Cell>
                      <Table.Summary.Cell index={3} align="right" className="text-slate-400">
                        -
                      </Table.Summary.Cell>
                      {(inspectRecord.members || []).map((m, idx) => {
                        const mStat = inspectStats.memberTotalsMap[m.id];
                        return (
                          <Table.Summary.Cell
                            key={m.id}
                            index={4 + idx}
                            align="center"
                            className="font-tabular font-bold text-[#0F172A]"
                          >
                            {mStat ? mStat.totalCap : 0}
                          </Table.Summary.Cell>
                        );
                      })}
                    </Table.Summary.Row>
                    <Table.Summary.Row className="bg-slate-50 font-semibold">
                      <Table.Summary.Cell index={0} colSpan={2} className="font-semibold text-slate-700">
                        TỔNG ĐIỂM
                      </Table.Summary.Cell>
                      <Table.Summary.Cell
                        index={2}
                        align="right"
                        className="font-tabular font-bold text-[#2563EB] whitespace-nowrap"
                      >
                        {inspectStats.assignedTotalPoints.toLocaleString('vi-VN')} point
                      </Table.Summary.Cell>
                      <Table.Summary.Cell index={3} align="right" className="text-slate-400">
                        -
                      </Table.Summary.Cell>
                      {(inspectRecord.members || []).map((m, idx) => {
                        const mStat = inspectStats.memberTotalsMap[m.id];
                        return (
                          <Table.Summary.Cell
                            key={m.id}
                            index={4 + idx}
                            align="center"
                            className="font-tabular font-semibold text-[#2563EB] whitespace-nowrap"
                          >
                            {(mStat ? mStat.totalPoints : 0).toLocaleString('vi-VN')} point
                          </Table.Summary.Cell>
                        );
                      })}
                    </Table.Summary.Row>
                  </Table.Summary>
                ) : null
              }
            />
          </div>
        )}
      </Modal>
    </div>
  );
}
