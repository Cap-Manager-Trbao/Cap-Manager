import React, { useEffect, useState } from 'react';
import { Alert, Form, Input, Modal } from 'antd';
import { KeyRound } from 'lucide-react';

export default function ChangePasswordModal({
  open,
  groupName,
  username,
  onClose,
  onSubmit,
}) {
  const [form] = Form.useForm();
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');

  useEffect(() => {
    if (open) {
      form.resetFields();
      setErrorMsg('');
    }
  }, [open, form]);

  const handleOk = async () => {
    try {
      const values = await form.validateFields();
      setErrorMsg('');
      setSubmitting(true);
      const res = await onSubmit(values.currentPassword, values.newPassword);
      if (res && res.ok) {
        onClose();
      } else if (res && res.error) {
        setErrorMsg(res.error);
      }
    } catch {
      // inline form validation
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      title={
        <div className="flex items-center gap-2">
          <KeyRound className="w-4 h-4 text-[#2563EB]" />
          <span>Đổi mật khẩu Leader</span>
        </div>
      }
      open={open}
      onCancel={onClose}
      onOk={handleOk}
      confirmLoading={submitting}
      okText="Cập nhật mật khẩu"
      cancelText="Hủy"
      width={430}
    >
      <div className="pt-2 flex flex-col gap-3">
        <div className="text-xs text-slate-600 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2">
          Nhóm: <strong className="text-slate-900">{groupName}</strong> · Tài khoản:{' '}
          <strong className="font-tabular text-slate-900">{username}</strong>
        </div>

        {errorMsg && <Alert type="error" showIcon title={errorMsg} />}

        <Form
          form={form}
          layout="vertical"
          onFinish={handleOk}
          onValuesChange={() => {
            if (errorMsg) setErrorMsg('');
          }}
        >
          <Form.Item
            name="currentPassword"
            label="Mật khẩu hiện tại"
            rules={[{ required: true, message: 'Vui lòng nhập mật khẩu hiện tại' }]}
          >
            <Input.Password
              placeholder="Nhập mật khẩu hiện tại"
              autoComplete="current-password"
            />
          </Form.Item>

          <Form.Item
            name="newPassword"
            label="Mật khẩu mới"
            rules={[
              { required: true, message: 'Vui lòng nhập mật khẩu mới' },
              { min: 6, message: 'Mật khẩu mới cần tối thiểu 6 ký tự' },
            ]}
          >
            <Input.Password
              placeholder="Tối thiểu 6 ký tự"
              autoComplete="new-password"
            />
          </Form.Item>

          <Form.Item
            name="confirmPassword"
            label="Xác nhận mật khẩu mới"
            dependencies={['newPassword']}
            rules={[
              { required: true, message: 'Vui lòng nhập lại mật khẩu mới' },
              ({ getFieldValue }) => ({
                validator(_, value) {
                  if (!value || getFieldValue('newPassword') === value) {
                    return Promise.resolve();
                  }
                  return Promise.reject(new Error('Mật khẩu xác nhận không khớp'));
                },
              }),
            ]}
          >
            <Input.Password
              placeholder="Nhập lại mật khẩu mới"
              autoComplete="new-password"
            />
          </Form.Item>
        </Form>
      </div>
    </Modal>
  );
}
