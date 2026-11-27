import React from 'react';
import { Button, Result } from 'antd';

export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, errorMessage: '' };
  }

  static getDerivedStateFromError(error) {
    return {
      hasError: true,
      errorMessage: error?.message || 'Đã xảy ra lỗi khi đồng bộ dữ liệu.',
    };
  }

  render() {
    if (this.state.hasError) {
      let friendly = this.state.errorMessage;
      try {
        const parsed = JSON.parse(this.state.errorMessage);
        if (parsed?.error) {
          friendly = parsed.error.includes('Quota exceeded')
            ? 'Hệ thống Firestore tạm vượt giới hạn đọc/ghi miễn phí trong ngày. Vui lòng thử lại vào ngày mai.'
            : `Lỗi kết nối cơ sở dữ liệu (${parsed.operationType || 'read'}): ${parsed.error}`;
        }
      } catch {
        // plain string message
      }

      return (
        <div className="min-h-screen flex items-center justify-center bg-[#F8FAFC] p-6">
          <div className="max-w-lg w-full bg-white rounded-xl border border-slate-200 p-6 shadow-sm">
            <Result
              status="error"
              title="Không thể tải dữ liệu CAP Manager"
              subTitle={friendly}
              extra={
                <Button type="primary" onClick={() => window.location.reload()}>
                  Tải lại trang
                </Button>
              }
            />
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
