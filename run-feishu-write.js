
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { exec } from 'child_process';

const CLAUDE_CONFIG_DIR = path.join(process.cwd(), 'data/config');
const CLAUDE_CONFIG_KEY_FILE = path.join(CLAUDE_CONFIG_DIR, 'encryption-key.bin');

// 获取加密密钥
function getOrCreateEncryptionKey() {
  if (fs.existsSync(CLAUDE_CONFIG_KEY_FILE)) {
    const key = fs.readFileSync(CLAUDE_CONFIG_KEY_FILE);
    if (key.length === 32) return key;
    throw new Error('Invalid encryption key file');
  }

  const key = crypto.randomBytes(32);
  fs.writeFileSync(CLAUDE_CONFIG_KEY_FILE, key, {
    encoding: 'binary',
    mode: 0o600,
  });
  return key;
}

// 解密函数
function decryptFeishuSecret(secrets) {
  const key = getOrCreateEncryptionKey();
  const iv = Buffer.from(secrets.iv, 'base64');
  const tag = Buffer.from(secrets.tag, 'base64');
  const encrypted = Buffer.from(secrets.data, 'base64');

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);

  const decrypted = Buffer.concat([
    decipher.update(encrypted),
    decipher.final(),
  ]).toString('utf-8');
  const parsed = JSON.parse(decrypted);
  return {
    appSecret: parsed.appSecret,
  };
}

// 读取并解密飞书配置
function readFeishuConfig() {
  const configPath = path.join(process.cwd(), 'data/config/feishu-provider.json');
  const content = fs.readFileSync(configPath, 'utf8');
  const config = JSON.parse(content);

  const secret = decryptFeishuSecret(config.secret);
  return {
    appId: config.appId,
    appSecret: secret.appSecret,
  };
}

// 主函数
function main() {
  try {
    const feishuConfig = readFeishuConfig();
    console.log('✅ 成功解密飞书配置');

    // 设置环境变量并运行 write_bitable.py
    const command = `
      export FEISHU_APP_ID="${feishuConfig.appId}" &&
      export FEISHU_APP_SECRET="${feishuConfig.appSecret}" &&
      python3 /root/happyclaw/data/sessions/task-177442818811/.claude/skills/ai-tech-intel/scripts/write_bitable.py
    `;

    console.log('🚀 开始运行 write_bitable.py');

    exec(command, { shell: '/bin/bash', encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) {
        console.error('❌ 命令执行失败:', error);
        return;
      }

      if (stderr) {
        console.error('⚠️ 警告:', stderr);
      }

      console.log('✅ write_bitable.py 执行成功');
      console.log('输出内容:', stdout);
    });

  } catch (error) {
    console.error('❌ 执行失败:', error);
  }
}

main();
