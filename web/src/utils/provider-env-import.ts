import { buildDefaultProviderEnv, parseProviderModel } from './provider-model';

export type ProviderAuthMode = 'bearer' | 'x-api-key';

/** What a pasted shell alias / env block contributes to a third-party form. */
export interface ProviderEnvImport {
  /** Alias name, used as the configuration name when the form has none. */
  name: string | null;
  baseUrl: string | null;
  token: string | null;
  authMode: ProviderAuthMode | null;
  /** Model without the `[1m]` suffix; null when the paste sets none. */
  model: string | null;
  oneMillionContext: boolean;
  /** Prefilled rows whose pasted value differs from the computed default. */
  envOverrides: Record<string, string>;
  customEnv: Record<string, string>;
  /** Proxy variables are reported, never applied automatically. */
  proxyEnv: Record<string, string>;
  /** Keys that cannot be imported, with the reason. */
  rejected: Array<{ key: string; reason: string }>;
  warnings: string[];
}

const ENV_ASSIGNMENT_RE = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/;
const PROXY_KEYS = new Set([
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
]);
/** Mirrors the backend's dangerous env list (src/runtime-config.ts). */
const DANGEROUS_KEYS = new Set([
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'LD_AUDIT',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'DYLD_FRAMEWORK_PATH',
  'NODE_OPTIONS',
  'JAVA_TOOL_OPTIONS',
  'PERL5OPT',
  'PATH',
  'PYTHONPATH',
  'RUBYLIB',
  'PERL5LIB',
  'GIT_EXEC_PATH',
  'CDPATH',
  'BASH_ENV',
  'ENV',
  'PROMPT_COMMAND',
  'ZDOTDIR',
  'EDITOR',
  'VISUAL',
  'PAGER',
  'SSH_AUTH_SOCK',
  'SSH_AGENT_PID',
  'GIT_SSH',
  'GIT_SSH_COMMAND',
  'GIT_ASKPASS',
  'HOME',
  'TMPDIR',
  'TEMP',
  'TMP',
  'CLAUDE_CONFIG_DIR',
]);

interface ShellWord {
  text: string;
  /** `$` or a backtick outside single quotes: the shell would expand it. */
  expands: boolean;
}

/**
 * Split shell text into words the way POSIX sh would, without expanding
 * anything: single quotes are literal, double quotes honour `\" \\ \$ \``,
 * a backslash-newline continues the line, and `#` starts a comment.
 * Returns one array of words per logical line.
 */
export function splitShellWords(input: string): ShellWord[][] {
  const lines: ShellWord[][] = [];
  let words: ShellWord[] = [];
  let current = '';
  let expands = false;
  let inWord = false;
  let quote: "'" | '"' | null = null;

  const endWord = () => {
    if (inWord) words.push({ text: current, expands });
    current = '';
    expands = false;
    inWord = false;
  };
  const endLine = () => {
    endWord();
    if (words.length > 0) lines.push(words);
    words = [];
  };

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (quote === "'") {
      if (ch === "'") quote = null;
      else current += ch;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') {
        quote = null;
      } else if (ch === '\\' && i + 1 < input.length) {
        const next = input[i + 1];
        if (next === '\n') {
          i += 1;
        } else if ('"\\$`'.includes(next)) {
          current += next;
          i += 1;
        } else {
          current += ch;
        }
      } else {
        if (ch === '$' || ch === '`') expands = true;
        current += ch;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      inWord = true;
    } else if (ch === '\\') {
      const next = input[i + 1];
      if (next === '\n') {
        i += 1;
      } else if (next !== undefined) {
        current += next;
        inWord = true;
        i += 1;
      }
    } else if (ch === '\n' || ch === ';') {
      endLine();
    } else if (ch === ' ' || ch === '\t' || ch === '\r') {
      endWord();
    } else if (ch === '#' && !inWord) {
      while (i + 1 < input.length && input[i + 1] !== '\n') i += 1;
    } else {
      if (ch === '$' || ch === '`') expands = true;
      current += ch;
      inWord = true;
    }
  }
  endLine();
  return lines;
}

interface CollectedEnv {
  name: string | null;
  entries: Array<{ key: string; value: string; expands: boolean }>;
  commandModel: string | null;
  ignoredArgs: string[];
}

function collectFromWords(lines: ShellWord[][]): CollectedEnv {
  const collected: CollectedEnv = {
    name: null,
    entries: [],
    commandModel: null,
    ignoredArgs: [],
  };
  for (const words of lines) {
    let index = 0;
    // `alias kcc="A=1 B=2 claude ..."`: the value is itself a command line.
    if (words[0]?.text === 'alias' && words[1]) {
      const match = /^([^=]+)=([\s\S]*)$/.exec(words[1].text);
      if (match) {
        collected.name ??= match[1];
        const inner = collectFromWords(splitShellWords(match[2]));
        collected.entries.push(...inner.entries);
        collected.commandModel ??= inner.commandModel;
        collected.ignoredArgs.push(...inner.ignoredArgs);
        continue;
      }
    }
    while (words[index]?.text === 'export' || words[index]?.text === 'env') {
      index += 1;
    }
    for (; index < words.length; index += 1) {
      const match = ENV_ASSIGNMENT_RE.exec(words[index].text);
      if (!match) break;
      collected.entries.push({
        key: match[1],
        value: match[2],
        expands: words[index].expands,
      });
    }
    // Whatever follows the assignments is the launched command.
    const args = words.slice(index).map((word) => word.text);
    for (let i = 1; i < args.length; i += 1) {
      if (args[i] === '--model' && args[i + 1]) {
        collected.commandModel ??= args[i + 1];
        i += 1;
      } else if (args[i].startsWith('--model=')) {
        collected.commandModel ??= args[i].slice('--model='.length);
      } else {
        collected.ignoredArgs.push(args[i]);
      }
    }
  }
  return collected;
}

function collectFromJson(input: string): CollectedEnv | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  const env =
    record.env && typeof record.env === 'object' && !Array.isArray(record.env)
      ? (record.env as Record<string, unknown>)
      : record;
  return {
    name: null,
    entries: Object.entries(env)
      .filter(
        ([, value]) => typeof value === 'string' || typeof value === 'number',
      )
      .map(([key, value]) => ({ key, value: String(value), expands: false })),
    commandModel: typeof record.model === 'string' ? record.model : null,
    ignoredArgs: [],
  };
}

/**
 * Parse a pasted shell alias, `export` lines, a `.env` block or a Claude Code
 * `settings.json` env object into third-party provider fields. Nothing is
 * expanded: values that depend on `$VAR` or command substitution are
 * rejected so a half-resolved secret never gets saved.
 */
export function parseProviderEnvImport(input: string): ProviderEnvImport {
  const trimmed = input.trim();
  const collected =
    (trimmed.startsWith('{') ? collectFromJson(trimmed) : null) ??
    collectFromWords(splitShellWords(trimmed));

  const result: ProviderEnvImport = {
    name: collected.name,
    baseUrl: null,
    token: null,
    authMode: null,
    model: null,
    oneMillionContext: false,
    envOverrides: {},
    customEnv: {},
    proxyEnv: {},
    rejected: [],
    warnings: [],
  };

  const env = new Map<string, string>();
  for (const entry of collected.entries) {
    if (entry.expands) {
      result.rejected.push({
        key: entry.key,
        reason: '值依赖 shell 变量或命令替换，请粘贴展开后的实际值',
      });
      continue;
    }
    env.set(entry.key, entry.value);
  }

  const modelValue = env.get('ANTHROPIC_MODEL') ?? collected.commandModel;
  if (modelValue) {
    const selection = parseProviderModel(modelValue);
    result.model = selection.model;
    result.oneMillionContext = selection.oneMillionContext;
  }
  if (!env.has('ANTHROPIC_DEFAULT_HAIKU_MODEL')) {
    const smallFast = env.get('ANTHROPIC_SMALL_FAST_MODEL');
    if (smallFast) env.set('ANTHROPIC_DEFAULT_HAIKU_MODEL', smallFast);
  }

  const defaults = new Map(
    buildDefaultProviderEnv(result.model ?? '', result.oneMillionContext).map(
      (row) => [row.key, row.value],
    ),
  );

  for (const [key, value] of env) {
    if (key === 'ANTHROPIC_BASE_URL') {
      result.baseUrl = value.trim();
    } else if (key === 'ANTHROPIC_AUTH_TOKEN') {
      result.token = value.trim();
      result.authMode = 'bearer';
    } else if (key === 'ANTHROPIC_API_KEY') {
      if (!env.has('ANTHROPIC_AUTH_TOKEN')) {
        result.token = value.trim();
        result.authMode = 'x-api-key';
      }
    } else if (
      key === 'ANTHROPIC_MODEL' ||
      key === 'ANTHROPIC_SMALL_FAST_MODEL'
    ) {
      // Already folded into the model fields above.
    } else if (defaults.has(key)) {
      if (value !== defaults.get(key)) result.envOverrides[key] = value;
    } else if (PROXY_KEYS.has(key.toUpperCase())) {
      result.proxyEnv[key] = value;
    } else if (key === 'CLAUDE_CODE_OAUTH_TOKEN') {
      result.rejected.push({
        key,
        reason: '这是 Claude 官方订阅凭据，请改用「官方」类型配置',
      });
    } else if (DANGEROUS_KEYS.has(key) || key.startsWith('HAPPYCLAW_')) {
      result.rejected.push({ key, reason: '出于安全原因不允许配置' });
    } else {
      result.customEnv[key] = value;
    }
  }

  if (Object.keys(result.proxyEnv).length > 0) {
    result.warnings.push(
      '代理变量未导入：模型配置里的代理会影响 Agent 的所有网络请求，请在系统或工作区层面配置代理。',
    );
  }
  if (collected.ignoredArgs.length > 0) {
    result.warnings.push(
      `已忽略命令行参数：${collected.ignoredArgs.join(' ')}`,
    );
  }
  if (!result.baseUrl && !result.token && env.size === 0) {
    result.warnings.push(
      '没有识别到环境变量，请粘贴形如 ANTHROPIC_BASE_URL=... 的内容。',
    );
  }
  return result;
}
