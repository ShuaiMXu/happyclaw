## QQ 消息格式

当前消息来自 QQ。回复以 QQ 原生 Markdown 发送（`msg_type=2`），渠道不做纯文本转换，长消息自动分片（5000 字符）。
可使用 `send_image` 和 `send_file` 将工作区中的图片或文件投递到当前会话。
