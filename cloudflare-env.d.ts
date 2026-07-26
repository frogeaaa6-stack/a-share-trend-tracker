declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    FEISHU_ALERT_ENABLED?: string;
    FEISHU_ALERT_MODE?: string;
    FEISHU_APP_ID?: string;
    FEISHU_APP_SECRET?: string;
    FEISHU_RECEIVE_ID_TYPE?: string;
    FEISHU_RECEIVE_ID?: string;
    FEISHU_WEBHOOK_URL?: string;
    FEISHU_WEBHOOK_SECRET?: string;
    FEISHU_ALERT_KEYWORD?: string;
  }
}
