
import { getFeishuProviderConfig } from './src/runtime-config.js';

async function main() {
  try {
    const config = getFeishuProviderConfig();
    console.log('✅ 飞书配置');
    console.log(`appId: ${config.appId}`);
    console.log(`appSecret: ${config.appSecret}`);

    // 尝试直接运行 write_bitable.py 并传递环境变量
    const { exec } = await import('child_process');
    const command = `
      export FEISHU_APP_ID="${config.appId}" &&
      export FEISHU_APP_SECRET="${config.appSecret}" &&
      python3 /root/happyclaw/data/sessions/task-177442818811/.claude/skills/ai-tech-intel/scripts/write_bitable.py
    `;

    console.log('🚀 开始运行 write_bitable.py');

    exec(command, { shell: '/bin/bash' }, (error, stdout, stderr) => {
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
