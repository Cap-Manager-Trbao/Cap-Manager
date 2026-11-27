import React, { useState } from 'react';
import { Button, Drawer, Select } from 'antd';
import {
  LayoutDashboard,
  SlidersHorizontal,
  Briefcase,
  Users,
  FolderKanban,
  History,
  Settings,
  Menu,
  Sparkles,
  FileSpreadsheet,
  KeyRound,
  LogOut,
  ShieldCheck,
  Eye,
} from 'lucide-react';

const LEADER_MENU_ITEMS = [
  { key: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { key: 'distribute', label: 'Chia CAP', icon: SlidersHorizontal },
  { key: 'campaigns', label: 'Quản lý offer', icon: Briefcase },
  { key: 'members', label: 'Thành viên & Ca làm', icon: Users },
  { key: 'groups', label: 'Nhóm & Leader', icon: FolderKanban },
  { key: 'history', label: 'Lịch sử', icon: History },
  { key: 'settings', label: 'Cài đặt', icon: Settings },
];

const VIEWER_MENU_ITEMS = [
  { key: 'dashboard', label: 'Xem chia CAP', icon: LayoutDashboard },
  { key: 'members', label: 'Quản lý ca làm', icon: Users },
];

export default function LayoutShell({
  activeTab,
  onTabChange,
  groups,
  activeGroup,
  onSelectGroup,
  authSession,
  canEditActiveGroup,
  onOpenLogin,
  onOpenChangePassword,
  onLogout,
  onAutoDistribute,
  onExportExcel,
  children,
}) {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const menuItems = canEditActiveGroup ? LEADER_MENU_ITEMS : VIEWER_MENU_ITEMS;
  const activeItem = menuItems.find((item) => item.key === activeTab) || menuItems[0];

  const renderSidebarContent = (isMobile = false) => (
    <div className="flex flex-col h-full">
      {/* Group Selector */}
      <div className="px-3.5 pt-4 pb-3 border-b border-slate-800/80">
        <label htmlFor={isMobile ? 'group-select-mobile' : 'group-select-desktop'} className="block text-[11px] font-medium text-slate-400 mb-1.5">
          Nhóm đang xem
        </label>
        <Select
          id={isMobile ? 'group-select-mobile' : 'group-select-desktop'}
          value={activeGroup?.id}
          onChange={(val) => {
            onSelectGroup(val);
            if (isMobile) setMobileMenuOpen(false);
          }}
          className="w-full"
          size="middle"
          options={groups.map((g) => ({
            value: g.id,
            label: `${g.name} (${g.members?.length || 0} TV)`,
          }))}
        />
      </div>

      {/* Navigation */}
      <nav aria-label="Menu chính" className="flex-1 flex flex-col gap-1 px-3 py-3 overflow-y-auto cap-sidebar-scroll">
        {menuItems.map((item) => {
          const Icon = item.icon;
          const isActive = activeTab === item.key;
          return (
            <button
              key={item.key}
              type="button"
              onClick={() => {
                onTabChange(item.key);
                if (isMobile) setMobileMenuOpen(false);
              }}
              className={`w-full flex items-center gap-3 px-3.5 py-2.5 rounded-lg text-sm font-medium transition-colors whitespace-nowrap shrink-0 text-left cursor-pointer ${
                isActive
                  ? 'bg-[#2563EB] text-white'
                  : 'text-slate-300 hover:bg-[#13223D] hover:text-white'
              }`}
            >
              <Icon className="w-4 h-4 shrink-0" aria-hidden="true" />
              <span>{item.label}</span>
            </button>
          );
        })}
      </nav>

      {/* Account / Leader Permission Footer */}
      <div className="p-3 border-t border-slate-800/80 bg-[#070E1A]/60">
        {authSession ? (
          <div className="flex flex-col gap-2">
            <div className="flex items-start gap-2 text-xs">
              <ShieldCheck className="w-4 h-4 text-blue-400 shrink-0 mt-0.5" aria-hidden="true" />
              <div className="min-w-0">
                <div className="font-semibold text-white truncate">{authSession.displayName}</div>
                <div className="text-[11px] text-slate-400 truncate">
                  {canEditActiveGroup
                    ? `Quyền Nhóm trưởng: ${activeGroup?.name}`
                    : `Chế độ người xem (${activeGroup?.name})`}
                </div>
              </div>
            </div>
            {!canEditActiveGroup && (
              <button
                type="button"
                onClick={() => {
                  onSelectGroup(authSession.groupId);
                  if (isMobile) setMobileMenuOpen(false);
                }}
                className="w-full px-2.5 py-1.5 rounded text-xs font-medium bg-[#1D4ED8]/40 text-blue-200 hover:bg-[#1D4ED8]/60 cursor-pointer whitespace-nowrap"
              >
                Về nhóm của tôi
              </button>
            )}
            {canEditActiveGroup && onOpenChangePassword && (
              <button
                type="button"
                onClick={() => {
                  onOpenChangePassword();
                  if (isMobile) setMobileMenuOpen(false);
                }}
                className="w-full flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded text-xs font-medium bg-[#13223D] text-slate-200 hover:bg-[#1D3257] hover:text-white cursor-pointer whitespace-nowrap"
              >
                <KeyRound className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                <span>Đổi mật khẩu</span>
              </button>
            )}
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => {
                  onOpenLogin();
                  if (isMobile) setMobileMenuOpen(false);
                }}
                className="flex-1 px-2.5 py-1.5 rounded text-xs font-medium bg-[#13223D] text-slate-200 hover:bg-[#1D3257] cursor-pointer whitespace-nowrap"
              >
                Đổi tài khoản
              </button>
              <button
                type="button"
                onClick={onLogout}
                aria-label="Đăng xuất về chế độ người xem"
                title="Đăng xuất"
                className="px-2.5 py-1.5 rounded text-xs font-medium bg-[#13223D] text-slate-300 hover:text-white hover:bg-[#1D3257] cursor-pointer"
              >
                <LogOut className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-1.5 text-xs text-slate-300">
              <Eye className="w-3.5 h-3.5 text-slate-400 shrink-0" aria-hidden="true" />
              <span>Chế độ người xem & Chọn ca</span>
            </div>
            <button
              type="button"
              onClick={() => {
                onOpenLogin();
                if (isMobile) setMobileMenuOpen(false);
              }}
              className="w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold bg-[#2563EB] text-white hover:bg-[#1D4ED8] cursor-pointer whitespace-nowrap"
            >
              <KeyRound className="w-3.5 h-3.5" />
              <span>Đăng nhập Leader</span>
            </button>
          </div>
        )}
      </div>
    </div>
  );

  return (
    <div className="min-h-screen flex bg-[#F8FAFC] text-slate-900">
      {/* Desktop Left Sidebar */}
      <aside className="hidden lg:flex lg:flex-col lg:w-64 lg:fixed lg:inset-y-0 bg-[#0B1528] text-white border-r border-slate-800/80 z-30">
        <div className="h-16 flex flex-col justify-center px-5 border-b border-slate-800/80 shrink-0">
          <span className="text-lg font-bold tracking-tight text-white whitespace-nowrap shrink-0 leading-tight">
            CAP Manager
          </span>
          <span className="text-[11px] font-medium text-slate-400 whitespace-nowrap leading-tight mt-0.5">
            Design by Trung Bảo
          </span>
        </div>
        {renderSidebarContent(false)}
      </aside>

      {/* Mobile Drawer Navigation */}
      <Drawer
        placement="left"
        open={mobileMenuOpen}
        onClose={() => setMobileMenuOpen(false)}
        size={260}
        styles={{
          body: { padding: 0, backgroundColor: '#0B1528' },
          header: { backgroundColor: '#0B1528', borderBottom: '1px solid #1E293B', color: '#FFFFFF' },
        }}
        title={
          <div className="flex flex-col leading-tight">
            <span className="text-white font-bold">CAP Manager</span>
            <span className="text-[11px] font-normal text-slate-400">Design by Trung Bảo</span>
          </div>
        }
        closeIcon={<span className="text-slate-300 text-base">✕</span>}
      >
        {renderSidebarContent(true)}
      </Drawer>

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col min-w-0 lg:pl-64">
        <header className="sticky top-0 z-20 h-16 bg-white border-b border-slate-200 px-4 sm:px-6 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={() => setMobileMenuOpen(true)}
              aria-label="Mở menu điều hướng"
              className="lg:hidden inline-flex items-center justify-center w-11 h-11 rounded-lg border border-slate-200 text-slate-700 hover:bg-slate-50 cursor-pointer shrink-0"
            >
              <Menu className="w-5 h-5" />
            </button>
            <div className="flex items-center gap-2 text-sm min-w-0">
              <span className="hidden sm:inline text-slate-400 whitespace-nowrap">{activeGroup?.name || 'Nhóm 1'}</span>
              <span className="hidden sm:inline text-slate-300" aria-hidden="true">/</span>
              <h1 className="text-base sm:text-lg font-semibold text-slate-900 m-0 truncate">
                {activeItem.label}
              </h1>
            </div>
          </div>

          <div className="flex items-center gap-2.5 shrink-0">
            <div className="hidden sm:block">
              <Button
                onClick={onExportExcel}
                icon={<FileSpreadsheet className="w-4 h-4" />}
                className="inline-flex items-center whitespace-nowrap shrink-0"
              >
                Xuất Excel
              </Button>
            </div>
            {canEditActiveGroup ? (
              <Button
                type="primary"
                onClick={onAutoDistribute}
                icon={<Sparkles className="w-4 h-4" />}
                className="inline-flex items-center font-semibold whitespace-nowrap shrink-0"
              >
                Tự động chia CAP
              </Button>
            ) : (
              <Button
                type="primary"
                onClick={onOpenLogin}
                icon={<KeyRound className="w-4 h-4" />}
                className="inline-flex items-center font-semibold whitespace-nowrap shrink-0"
              >
                Đăng nhập Leader
              </Button>
            )}
          </div>
        </header>

        <main className="flex-1 p-4 sm:p-6 max-w-[1440px] w-full mx-auto">
          {children}
        </main>
        <footer className="lg:hidden px-4 sm:px-6 py-3 border-t border-slate-200/80 text-center text-xs text-slate-400">
          Design by <span className="font-medium text-slate-600">Trung Bảo</span>
        </footer>
      </div>
    </div>
  );
}
