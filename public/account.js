const UNKNOWN = '未知（服务未提供）';
const value = input => input === null || input === undefined || input === '' ? UNKNOWN : String(input).slice(0, 1000);
const boolean = input => input === true ? '是' : input === false ? '否' : UNKNOWN;
export function accountRows(response, demo = false) {
  const account = response?.account;
  const rows = [['数据来源', demo ? '演示模式，没有真实账户' : '本机 Codex account/read']];
  if (!account || typeof account !== 'object') return [...rows, ['账户状态', UNKNOWN], ['服务要求 OpenAI 登录', boolean(response?.requiresOpenaiAuth)]];
  rows.push(['授权类型', ({chatgpt:'ChatGPT',apiKey:'API 密钥（不会显示密钥）',amazonBedrock:'Amazon Bedrock',gcp:'Google Cloud'})[account.type] || value(account.type)]);
  if (account.type === 'chatgpt') rows.push(['邮箱', value(account.email)], ['套餐', value(account.planType)], ['工作区', value(account.workspaceName)]);
  rows.push(['服务要求 OpenAI 登录', boolean(response?.requiresOpenaiAuth)]); return rows;
}
export function usageRows(response, demo = false, date = timestamp => new Date(timestamp * 1000).toLocaleString()) {
  const groups = [{ title: '额度状态', rows: [['数据来源', demo ? '演示模式，没有真实用量' : '本机 Codex account/rateLimits/read'], ['服务允许普通用量', boolean(response?.ordinaryUsageAllowed)]] }];
  const buckets = response?.rateLimitsByLimitId && typeof response.rateLimitsByLimitId === 'object' ? Object.entries(response.rateLimitsByLimitId).slice(0, 20) : [];
  if (!buckets.length && response?.rateLimits && typeof response.rateLimits === 'object') buckets.push(['默认额度', response.rateLimits]);
  if (!buckets.length) groups.push({title:'用量明细',rows:[['当前快照',UNKNOWN]]});
  for (const [key, bucket] of buckets) {
    if (!bucket || typeof bucket !== 'object') { groups.push({title:value(key),rows:[['当前快照',UNKNOWN]]}); continue; }
    const rows = [['套餐', value(bucket.planType)]];
    for (const [field, label] of [['primary','主要窗口'],['secondary','次要窗口']]) {
      const window = bucket[field];
      rows.push([label + '已使用', typeof window?.usedPercent === 'number' && Number.isFinite(window.usedPercent) ? `${window.usedPercent}%` : UNKNOWN]);
      rows.push([label + '时长', typeof window?.windowDurationMins === 'number' && Number.isFinite(window.windowDurationMins) ? `${window.windowDurationMins} 分钟` : UNKNOWN]);
      rows.push([label + '重置时间', typeof window?.resetsAt === 'number' && Number.isFinite(window.resetsAt) && window.resetsAt > 0 ? date(window.resetsAt) : UNKNOWN]);
    }
    rows.push(['服务报告存在积分',boolean(bucket.credits?.hasCredits)], ['服务报告无限额',boolean(bucket.credits?.unlimited)], ['积分余额',value(bucket.credits?.balance)], ['支出限制已触发',boolean(bucket.spendControlReached)]);
    groups.push({title:value(bucket.limitName || key),rows});
  }
  return groups;
}
