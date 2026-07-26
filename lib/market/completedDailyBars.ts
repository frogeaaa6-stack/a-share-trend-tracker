function shanghaiParts(now: Date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    date: `${value.year}-${value.month}-${value.day}`,
    minuteOfDay: Number(value.hour) * 60 + Number(value.minute),
  };
}

export function shanghaiCalendarDate(now = new Date()) {
  return shanghaiParts(now).date;
}

export function canServeCompleteOnly(lastDate: string | undefined, excludedDate: string | null) {
  return !excludedDate || Boolean(lastDate && lastDate < excludedDate);
}

export function completedDailyBarError(latestDate: string, scheduled: boolean, now = new Date()) {
  const clock = shanghaiParts(now);
  if (latestDate > clock.date) return "行情日期晚于上海当前日期，拒绝生成提醒";
  if (latestDate === clock.date && scheduled) {
    return "交易日 12:00 提醒只允许使用严格早于上海当日的完整 T-1 日线";
  }
  if (latestDate === clock.date && clock.minuteOfDay < 15 * 60 + 10) {
    return "当日日线尚未在 15:10 后确认完整，拒绝生成买卖提醒";
  }
  return null;
}
