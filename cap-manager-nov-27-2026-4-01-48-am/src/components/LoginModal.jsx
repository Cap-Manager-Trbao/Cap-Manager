import React, { useEffect, useState } from 'react';
import { Form, Input, Modal } from 'antd';
import { KeyRound } from 'lucide-react';

export default function LoginModal({
  open,
  groups,
  preselectedGroup,
  onClose,
  onLogin,
}) {
  const [form] = Form.useForm();
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (open) {
      form.resetFields();
      if (preselectedGroup?.leaderAccount?.username) {
        form.setFieldsValue({
          username: preselectedGroup.leaderAccount.username,
          password: '',
        });
      }
    }
  }, [open, preselectedGroup, form]);

  const handleSubmit = async () => {
    try {
      const values = await form.validateFields();
      setSubmitting(true);
      const ok = await onLogin(values.username.trim(), values.password);
      if (ok) {
        onClose();
      }
    } catch {
      // validation error shown inline
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      title={
        <div className="flex items-center gap-2">
          <KeyRound className="w-4 h-4 text-[#2563EB]" />
          <span>Đăng nhập tài khoản Leader nhóm</span>
        </div>
      }
      open={open}
      onCancel={onClose}
      onOk={handleSubmit}
      confirmLoading={submitting}
      okText="Đăng nhập"
      cancelText="Hủy"
      width={440}
    >
      <div className="pt-2 flex flex-col gap-3">
        <p className="text-xs text-slate-600 m-0">
          Mỗi nhóm có tài khoản Leader riêng để quản lý ca làm, offer, lịch sử và phân chia CAP của nhóm đó.
        </p>

        <Form form={form} layout="vertical" onFinish={handleSubmit}>
          <Form.Item
            name="username"
            label="Tên đăng nhập Leader"
            rules={[{ required: true, message: 'Vui lòng nhập tên đăng nhập' }]}
          >
            <Input placeholder="Ví dụ: leader1" autoComplete="username" />
          </Form.Item>

          <Form.Item
            name="password"
            label="Mật khẩu"
            rules={[{ required: true, message: 'Vui lòng nhập mật khẩu' }]}
          >
            <Input.Password placeholder="Nhập mật khẩu" autoComplete="current-password" />
          </Form.Item>
        </Form>

        <div className="p-3 rounded-lg bg-slate-50 border border-slate-200 text-xs text-slate-600">
          <div className="font-semibold text-slate-800 mb-1">Các nhóm hiện có:</div>
          <div className="flex flex-col gap-1">
            {groups.map((g) => (
              <div key={g.id} className="flex items-center justify-between gap-2 font-tabular">
                <span>
                  {g.name}: <strong className="text-slate-700">{g.leaderAccount?.username}</strong>
                </span>
                <button
                  type="button"
                  onClick={() =>
                    form.setFieldsValue({
                      username: g.leaderAccount?.username || '',
                      password: '',
                    })
                  }
                  className="text-[#2563EB] hover:underline cursor-pointer font-sans"
                >
                  Chọn tài khoản
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>
    </Modal>
  );
}
