/**
 * 插件版本的**唯一来源**。
 *
 * 单独放一个模块有两个原因：
 * 1. `lib/index.js` 既要把版本回给面板（status），`lib/mail.js` 又要把它写进
 *    RFC 2971 的 `ID` 命令——两边都 import 这里，就不会各写一份然后各自漂移；
 * 2. `mail.js` 反过来 import `index.js` 会形成循环依赖，所以不能拿 index.js 当来源。
 *
 * `package.json` 的 `version` 必须与这里一致——`test/manifest-check.mjs` 会比对，
 * 不一致就直接失败。
 */
export const VERSION = '1.1.6';
