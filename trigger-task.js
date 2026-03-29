
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import { initDatabase, getTaskById, getAllTasks, getAllRegisteredGroups } from './dist/db.js';
import { GroupQueue } from './dist/group-queue.js';
import { triggerTaskNow } from './dist/task-scheduler.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function main() {
  // 初始化数据库
  initDatabase();

  // 获取所有定时任务
  const tasks = getAllTasks();
  console.log('所有定时任务:');
  tasks.forEach(task => {
    console.log(`- ID: ${task.id}`);
    console.log(`  提示: ${task.prompt.slice(0, 60)}${task.prompt.length > 60 ? '...' : ''}`);
    console.log(`  状态: ${task.status}`);
    console.log(`  下次运行: ${task.next_run}`);
    console.log();
  });

  // 找到"今日情报"任务
  const targetTask = tasks.find(task => task.prompt.includes('今日情报'));
  if (!targetTask) {
    console.error('未找到"今日情报"任务');
    return;
  }

  console.log('找到目标任务:');
  console.log(`ID: ${targetTask.id}`);
  console.log(`提示: ${targetTask.prompt}`);
  console.log(`状态: ${targetTask.status}`);

  if (targetTask.status !== 'active') {
    console.error('任务状态不是 active，无法触发');
    return;
  }

  // 获取实际的注册群组
  const registeredGroups = getAllRegisteredGroups();
  console.log('实际注册群组:', Object.keys(registeredGroups));

  // 创建任务调度器依赖
  const deps = {
    registeredGroups: () => registeredGroups,
    getSessions: () => {
      // 返回一个实际的会话存储对象
      return {
        'task-177442818811': null // 任务工作区的会话 ID，初始为 null
      };
    },
    queue: new GroupQueue(),
    onProcess: () => {},
    sendMessage: async (jid, text, options) => {
      console.log(`发送消息到 ${jid}: ${text}`);
    },
    broadcastStreamEvent: (chatJid, event) => {
      console.log(`广播流事件到 ${chatJid}:`, event);
    },
    onWorkspaceCreated: (jid, folder, name, userId) => {
      console.log(`创建任务工作区: ${name} (${folder})`);
    },
    storePromptMessage: (chatJid, senderId, senderName, text) => {
      console.log(`存储提示消息到 ${chatJid}: ${text}`);
    },
    assistantName: 'HappyClaw'
  };

  // 触发任务
  console.log('\n正在触发任务...');
  const result = triggerTaskNow(targetTask.id, deps);

  if (result.success) {
    console.log('任务已成功触发！');
  } else {
    console.error(`任务触发失败: ${result.error}`);
  }
}

main().catch(err => {
  console.error('执行出错:', err);
  process.exit(1);
});
